import { defineConfig } from '@vscode/test-cli';

// run the integration suite against both the declared engines floor and
// current stable — a floor we never test against is a false claim
const base = {
  files: 'test/integration/**/*.test.js',
  workspaceFolder: 'test/fixtures',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
};

export default defineConfig([
  { label: 'floor-1.85', version: '1.85.0', ...base },
  { label: 'stable', version: 'stable', ...base },
]);
