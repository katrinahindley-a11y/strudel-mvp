from psycopg.pq import TransactionStatus
from psycopg.types.json import Jsonb
from ccod_import import SafeError, TITLE_COLUMNS, OWNER_COLUMNS, guard
from ccod_refresh_policy import qualification, owner_transfer_map

def capture(conn, title):
    row = conn.execute('SELECT to_jsonb(t) FROM public.property_titles t WHERE title_number = %s', (title,)).fetchone()
    owners = [r[0] for r in conn.execute('SELECT to_jsonb(p) FROM public.property_proprietors p WHERE title_number = %s ORDER BY proprietor_position', (title,))]
    reviews = [r[0] for r in conn.execute('SELECT to_jsonb(m) FROM public.property_charge_matches m WHERE title_number = %s ORDER BY id', (title,))]
    return (row[0] if row else None), owners, reviews

def source_state(title, owners):
    fields = [f for f in TITLE_COLUMNS.split(',') if f != 'source_snapshot_month']
    return ({f: title.get(f) for f in fields} if title else None, [{f: owner.get(f) for f in OWNER_COLUMNS.split(',')} for owner in owners])

def apply_title(conn, month, title_number, parsed=None, full_validated=False):
    if conn.info.transaction_status != TransactionStatus.INTRANS:
        raise SafeError('Caller-owned transaction required')
    if not full_validated or month.day != 1:
        raise SafeError('Validated complete snapshot and month start required')
    with conn.transaction():
        guard(conn)
        if not conn.execute('SELECT pg_try_advisory_xact_lock(724310921)').fetchone()[0]:
            raise SafeError('Another CCOD operation is running')
        conn.execute('SELECT title_number FROM public.property_titles WHERE title_number = %s FOR UPDATE', (title_number,))
        member = conn.execute('SELECT managed_high_value, retain_sample, active, retirement_reason, last_checked_month FROM ccod_import.refresh_membership WHERE title_number = %s FOR UPDATE', (title_number,)).fetchone()
        before_title, before_owners, before_reviews = capture(conn, title_number)
        if before_title and member is None:
            raise SafeError('Baseline membership must be initialized first')
        if member and month < member[4]:
            raise SafeError('Older snapshot rejected')
        if member and month == member[4]:
            raise SafeError('Same-month updates belong to release-level receipt verification')
        if parsed is None:
            status = 'absent_from_full_release'
        else:
            title, owners, raw = parsed
            if title[0] != title_number or any(owner[0] != title_number for owner in owners) or not owners:
                raise SafeError('Title or proprietor identity mismatch')
            status = qualification({'price_paid': title[9]})
        managed = bool(member and member[0])
        if status != 'qualifies' and not managed:
            return {'title_number': title_number, 'action': 'protected_sample' if before_title else 'outside_cohort'}
        new_owner_dicts = [dict(zip(OWNER_COLUMNS.split(','), owner)) for owner in parsed[1]] if parsed else before_owners
        transfer = owner_transfer_map(before_owners, new_owner_dicts) if parsed else {}
        if parsed:
            values = (*parsed[0], 'CCOD', month, Jsonb(parsed[2]))
            if before_title:
                fields = TITLE_COLUMNS.split(',')[1:]
                conn.execute('UPDATE public.property_titles SET ' + ','.join(f'{f} = %s' for f in fields) + ', updated_at = now() WHERE title_number = %s', (*values[1:], title_number))
            else:
                conn.execute(f'INSERT INTO public.property_titles ({TITLE_COLUMNS}) VALUES (' + ','.join(['%s'] * len(values)) + ')', values)
            old_by_position = {owner['proprietor_position']: owner for owner in before_owners}
            old_sources = [{f: owner.get(f) for f in OWNER_COLUMNS.split(',')} for owner in before_owners]
            if old_sources != new_owner_dicts:
                conn.execute('DELETE FROM public.property_proprietors WHERE title_number = %s', (title_number,))
                for owner in parsed[1]:
                    old = old_by_position.get(transfer[owner[1]], {})
                    evidence = old.get('company_match_evidence')
                    extra = (old.get('matched_company_id'), old.get('company_match_status', 'unmatched'), Jsonb(evidence) if evidence is not None else None)
                    columns = OWNER_COLUMNS + ',matched_company_id,company_match_status,company_match_evidence'
                    conn.execute(f'INSERT INTO public.property_proprietors ({columns}) VALUES (' + ','.join(['%s'] * (len(owner) + 3)) + ')', (*owner, *extra))
        active = status == 'qualifies'
        reason = None if active else status
        keep_sample = bool(member and member[1])
        last_seen = month if parsed else conn.execute('SELECT last_seen_month FROM ccod_import.refresh_membership WHERE title_number = %s', (title_number,)).fetchone()[0]
        conn.execute('INSERT INTO ccod_import.refresh_membership (title_number, managed_high_value, retain_sample, active, retirement_reason, last_checked_month, last_seen_month) VALUES (%s, true, %s, %s, %s, %s, %s) ON CONFLICT (title_number) DO UPDATE SET managed_high_value = true, active = EXCLUDED.active, retirement_reason = EXCLUDED.retirement_reason, last_checked_month = EXCLUDED.last_checked_month, last_seen_month = EXCLUDED.last_seen_month, updated_at = now()', (title_number, keep_sample, active, reason, month, last_seen))
        after_title, after_owners, after_reviews = capture(conn, title_number)
        if before_reviews != after_reviews:
            raise SafeError('Charge review data changed')
        state_changed = member is None or (member[2], member[3], member[0]) != (active, reason, True)
        changed = state_changed or source_state(before_title, before_owners) != source_state(after_title, after_owners)
        action = 'unchanged'
        if changed:
            action = 'added' if before_title is None else 'retired' if not active and member[2] else 'reactivated' if active and not member[2] else 'changed'
            conn.execute('INSERT INTO ccod_import.property_history (snapshot_month, title_number, event_kind, title_before, title_after, owners_before, owners_after, charge_reviews_before) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)', (month, title_number, action, Jsonb(before_title) if before_title else None, Jsonb(after_title), Jsonb(before_owners), Jsonb(after_owners), Jsonb(before_reviews)))
        guard(conn)
        return {'title_number': title_number, 'action': action, 'active': active, 'retirement_reason': reason}
