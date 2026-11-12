import csv
import json
import re
import sys
from ccod_import import SafeError
import ccod_csv_diagnostics as diagnostic

BaseReader = csv.DictReader

class FooterReader(BaseReader):
    record_number = 0

    def __next__(self):
        try:
            row = super().__next__()
        except csv.Error:
            raise SafeError('CSV syntax error at physical line ' + str(self.reader.line_num)) from None
        self.record_number += 1
        missing = [name for name in self.fieldnames if row.get(name) is None]
        extra = len(row.get(None, []))
        if not missing and None not in row:
            return row
        values = [row[name] for name in self.fieldnames if row.get(name) is not None] + row.get(None, [])
        detail = dict(record_number=self.record_number, physical_line_end=self.line_num, expected_fields=len(self.fieldnames), actual_fields=len(values), preceding_data_records=self.record_number - 1)
        try:
            detail['is_last_csv_record'] = next(self.reader, None) is None
        except csv.Error:
            detail['is_last_csv_record'] = False
            detail['following_csv_syntax_error'] = True
        if len(values) == 2 and detail['is_last_csv_record'] and len(values[0]) <= 128:
            count_text = values[1].strip()
            if re.fullmatch(r'[0-9]{1,12}', count_text) and int(count_text) == self.record_number - 1:
                detail['first_field_exact'] = values[0]
        inspected = []
        labels = {'eof', 'end', 'end of file', 'total', 'total records', 'total record count', 'record count', 'records', 'total number of records'}
        for index, value in enumerate(values):
            text = value.strip()
            item = dict(position=index + 1, character_count=len(text))
            normalized = re.sub(r'[_:\s-]+', ' ', text.lower()).strip()
            if normalized in labels:
                item['recognised_label'] = normalized
            elif re.fullmatch(r'[0-9]{1,12}', text):
                number = int(text)
                item['numeric_value'] = number
                item['matches_preceding_data_records'] = number == self.record_number - 1
            else:
                item['classification'] = 'unrecognised value; content withheld except conditional first_field_exact'
            inspected.append(item)
        detail['short_row_fields'] = inspected
        raise SafeError('Short-row inspection only; not accepted as footer: ' + json.dumps(detail, sort_keys=True))

if __name__ == '__main__':
    try:
        diagnostic.DiagnosticReader = FooterReader
        diagnostic.main()
    except SafeError as error:
        print('CCOD footer inspection stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD footer inspection failed: ' + type(error).__name__ + '; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
