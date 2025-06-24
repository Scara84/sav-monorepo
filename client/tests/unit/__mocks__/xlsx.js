// Mock pour la bibliothèque xlsx
export const utils = {
  json_to_sheet: (data) => ({
    '!ref': 'A1:Z100',
    '!cols': [],
    '!rows': [],
    '!merges': []
  }),
  book_new: () => ({}),
  book_append_sheet: (wb, ws, name) => {
    wb.SheetNames = wb.SheetNames || [];
    wb.Sheets = wb.Sheets || {};
    wb.SheetNames.push(name);
    wb.Sheets[name] = ws;
    return wb;
  },
  write: (wb, opts) => {
    return new Uint8Array(0);
  }
};

const xlsx = {
  utils,
  writeFile: jest.fn(),
  writeFileXLSX: jest.fn()
};

export default xlsx;
