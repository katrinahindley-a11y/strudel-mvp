import csv
import io
import json
import re
import sys
from ccod_import import SafeError
import ccod_csv_diagnostics as diagnostic

BaseReader = csv.DictReader

class FooterReader(BaseReader):
    data_count = 0
    footer_verified = False

    def __next__(self):
        if self.footer_verified:
            raise StopIteration
        try:
            row = super().__next__()
        except StopIteration:
            raise SafeError('Required Row Count: footer missing') from None
        except csv.Error:
            raise SafeError('CSV syntax error at physical line ' + str(self.reader.line_num)) from None
        values = [row[name] for name in self.fieldnames if row.get(name) is not None] + row.get(None, [])
        if row.get(self.fieldnames[0]) == 'Row Count:':
            if len(values) != 2 or None in row:
                raise SafeError('Row Count: footer must have exactly two fields')
            if not re.fullmatch(r'[0-9]{1,12}', values[1]) or int(values[1]) != self.data_count:
                raise SafeError('Footer count does not match preceding data records')
            try:
                following = next(self.reader, None)
            except csv.Error:
                raise SafeError('CSV syntax error after footer') from None
            if following is not None:
                raise SafeError('CSV record follows Row Count: footer')
            self.footer_verified = True
            print(json.dumps({'footer_verified': True, 'source_data_records': self.data_count}), flush=True)
            raise StopIteration
        if None in row or any(value is None for value in row.values()):
            raise SafeError('Malformed data row at record ' + str(self.data_count + 1))
        self.data_count += 1
        return row

def self_test():
    prefix = 'a,b,c\n1,2,3\n'
    reader = FooterReader(io.StringIO(prefix + 'Row Count:,1\n'), strict=True)
    if list(reader) != [{'a': '1', 'b': '2', 'c': '3'}] or not reader.footer_verified:
        raise AssertionError('Valid footer handling failed')
    cases = [prefix + 'Row Count:,2\n', prefix + 'Row Count:,1\n4,5,6\n', prefix + 'Bad Label,1\n', prefix, prefix + 'Row Count:,1,extra\n', prefix + 'Row Count:,not-a-number\n', 'a,b,c\n1,2\nRow Count:,1\n', prefix + 'Row Count:,1\nRow Count:,1\n']
    for text in cases:
        try:
            list(FooterReader(io.StringIO(text), strict=True))
        except SafeError:
            pass
        else:
            raise AssertionError('Invalid footer or malformed row accepted')
    print(str(len(cases) + 1) + ' footer tests passed; no credentials or database used.')

if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--self-test']:
            self_test()
        else:
            diagnostic.DiagnosticReader = FooterReader
            diagnostic.main()
    except SafeError as error:
        print('CCOD validation stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('CCOD validation failed: ' + type(error).__name__ + '; sensitive details suppressed.', file=sys.stderr)
        sys.exit(1)
