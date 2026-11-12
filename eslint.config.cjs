const tseslint = require('typescript-eslint');

module.exports = [{
  files: ['src/{apply,draft,permissions,policy,schedule-controller}.js'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: __dirname },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false, checkThenables: true }],
  },
}];
