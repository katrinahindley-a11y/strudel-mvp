import datetime as dt
import json
import re
from decimal import Decimal, InvalidOperation

THRESHOLD = Decimal('5000000')
OWNER_FIELDS = ('proprietor_name', 'registration_number_raw', 'proprietorship_category', 'address_1', 'address_2', 'address_3')

class PolicyError(ValueError):
    pass

def release_month(filename):
    match = re.fullmatch(r'CCOD_FULL_([0-9]{4})_([0-9]{2})[.]zip', filename or '')
    if not match:
        raise PolicyError('Invalid full-release filename')
    try:
        return dt.date(int(match[1]), int(match[2]), 1)
    except ValueError:
        raise PolicyError('Invalid release month') from None

def choose_release(resources, applied_month, today):
    candidates = {}
    for resource in resources:
        filename = resource.get('file_name') or resource.get('name')
        if not isinstance(filename, str) or not filename.startswith('CCOD_FULL_'):
            continue
        month = release_month(filename)
        if month > today.replace(day=1):
            raise PolicyError('Future-dated release requires review')
        candidates[month] = filename
    if not candidates:
        raise PolicyError('No full release available')
    latest = max(candidates)
    if applied_month is not None and latest <= applied_month:
        return None
    return candidates[latest]

def qualification(record):
    if record is None:
        return 'absent_from_full_release'
    value = record.get('price_paid')
    if value is None or value == '':
        return 'price_missing'
    if isinstance(value, bool):
        raise PolicyError('Boolean is not a price')
    try:
        price = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise PolicyError('Invalid price') from None
    if not price.is_finite() or price < 0:
        raise PolicyError('Invalid price')
    return 'qualifies' if price > THRESHOLD else 'recorded_price_not_above_threshold'

def retirement_reason(title, observed, managed_titles, validated_full):
    if title not in managed_titles:
        return None
    if not validated_full:
        raise PolicyError('Retirement forbidden without validated full snapshot')
    status = qualification(observed.get(title))
    return None if status == 'qualifies' else status

def owner_transfer_map(old_owners, new_owners):
    def identities(owners):
        result = {}
        positions = set()
        for owner in owners:
            position = owner.get('proprietor_position')
            if type(position) is not int or not 1 <= position <= 4 or position in positions:
                raise PolicyError('Invalid or duplicate proprietor position')
            positions.add(position)
            if not isinstance(owner.get('proprietor_name'), str) or not owner['proprietor_name'].strip():
                raise PolicyError('Missing proprietor name')
            identity = json.dumps([owner.get(field) for field in OWNER_FIELDS], ensure_ascii=False)
            if identity in result:
                raise PolicyError('Ambiguous repeated proprietor identity requires review')
            result[identity] = position
        return result
    old = identities(old_owners)
    new = identities(new_owners)
    return {position: old.get(identity) for identity, position in new.items()}

def check_retirement_budget(active_managed_count, retirement_count):
    if type(active_managed_count) is not int or type(retirement_count) is not int or not 0 <= retirement_count <= active_managed_count:
        raise PolicyError('Invalid retirement counts')
    if retirement_count * 10 > active_managed_count:
        raise PolicyError('More than ten percent retiring; manual review required')
