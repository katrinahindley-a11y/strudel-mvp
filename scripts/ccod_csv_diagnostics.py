import csv
import io
import json
import sys
from ccod_import import HEADERS, SafeError

class DiagnosticReader(csv.DictReader):
    record_number = 0

    def __next__(self):
        try:
            row = super().__next__()
        except csv.Error:
            raise SafeError('CSV syntax error at physical line ' + str(self.reader.line_num)) from None
        self.record_number += 1
        missing = [name for name in self.fieldnames if row.get(name) is None]
        extra = len(row.get(None, []))
        if missing or None in row:
            diagnostic = dict(record_number=self.record_number, physical_line_end=self.line_num, expected_fields=len(self.fieldnames), actual_fields=len(self.fieldnames) - len(missing) + extra, missing_field_positions=[i + 1 for i, name in enumerate(self.fieldnames) if name in missing], missing_known_fields=[name for name in missing if name in HEADERS], extra_field_count=extra)
            raise SafeError('Malformed CSV row: ' + json.dumps(diagnostic, sort_keys=True))
        return row

def self_test():
    reader = DiagnosticReader(io.StringIO('a,b\n1,2\n'), strict=True)
    if next(reader) != {'a': '1', 'b': '2'}:
        raise AssertionError('Valid row changed')
    for text, expected in [('a,b\n1\n', 1), ('a,b\n1,2,3\n', 3)]:
        try:
            next(DiagnosticReader(io.StringIO(text), strict=True))
        except SafeError as error:
            detail = json.loads(str(error).split(': ', 1)[1])
            if detail['actual_fields'] != expected or detail['record_number'] != 1 or detail['physical_line_end'] != 2:
                raise AssertionError('Incorrect structural diagnostic')
        else:
            raise AssertionError('Malformed row accepted')
    reader = DiagnosticReader(io.StringIO('a,b\n"line1\nline2",x\n'), strict=True)
    if next(reader)['a'] != 'line1\nline2' or reader.line_num != 3:
        raise AssertionError('Quoted multiline field changed')
    print('Four structural diagnostic tests passed; no credentials or database used.')

def main():
    if sys.argv[1:] == ['--self-test']:
        self_test()
        return
    import ccod_import
    import ccod_high_value_validate
    original = ccod_import.csv.DictReader
    ccod_import.csv.DictReader = DiagnosticReader
    try:
        ccod_high_value_validate.main()
    finally:
        ccod_import.csv.DictReader = original

if __name__ == '__main__':
    try:
        main()
    except SafeError as error:
        print('CCOD validation stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD diagnostic failed: ' + type(error).__name__ + '; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
