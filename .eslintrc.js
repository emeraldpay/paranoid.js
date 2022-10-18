module.exports = {
  env: {
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'import', 'unicorn', 'unused-imports'],
  root: true,
  rules: {
    '@typescript-eslint/naming-convention': [
      'error',
      {
        selector: 'objectLiteralProperty',
        format: ['camelCase', 'snake_case', 'StrictPascalCase', 'UPPER_CASE'],
      },
      {
        selector: 'objectLiteralProperty',
        modifiers: ['requiresQuotes'],
        format: null,
      },
      {
        selector: ['class', 'interface', 'typeAlias'],
        format: ['StrictPascalCase'],
      },
    ],
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    'comma-dangle': ['error', 'always-multiline'],
    curly: 'error',
    'newline-before-return': 'error',
    eqeqeq: [
      'error',
      'always',
      {
        null: 'ignore',
      },
    ],
    'import/order': [
      'error',
      {
        alphabetize: {
          order: 'asc',
          caseInsensitive: true,
        },
        groups: ['builtin', 'internal', 'external', 'sibling', 'index'],
        'newlines-between': 'never',
      },
    ],
    'max-len': ['error', 120],
    'no-lonely-if': 'error',
    'object-shorthand': ['error', 'always'],
    'padding-line-between-statements': ['error', { blankLine: 'always', prev: 'if', next: '*' }],
    'prefer-destructuring': 'error',
    'prefer-template': 'error',
    quotes: [
      'error',
      'single',
      {
        avoidEscape: true,
      },
    ],
    semi: 'error',
    'sort-imports': [
      'error',
      {
        ignoreDeclarationSort: true,
      },
    ],
    'unicorn/filename-case': [
      'error',
      {
        case: 'kebabCase',
      },
    ],
    'unused-imports/no-unused-imports': 'error',
  },
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts'],
    },
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
      },
    },
  },
};
