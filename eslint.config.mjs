import { flatConfigs as importConfigs } from 'eslint-plugin-import-x'
import prettier from 'eslint-plugin-prettier/recommended'
import tsESLint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
export default defineConfig([
  importConfigs.recommended,
  prettier,
  tsESLint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node
      },
      ecmaVersion: 2017,
      sourceType: 'module',
      parserOptions: {}
    },
    rules: {
      'array-bracket-spacing': [
        'error',
        'never',
        {
          objectsInArrays: false,
          arraysInArrays: false
        }
      ],

      'arrow-parens': ['error', 'always'],
      'comma-dangle': ['error', 'never'],
      'func-names': 'off',
      'import-x/named': 'off',
      'no-use-before-define': 'off',
      'prefer-destructuring': 'off',
      'no-console': 'error',
      'no-shadow': 'error',
      'no-undef': 'error',
      'object-curly-newline': 'off',
      'no-unused-vars': 'error',
      semi: 'off',
      'object-shorthand': 'off',
      'prettier/prettier': 'error',
      'prefer-const': 'error'
    }
  },
  globalIgnores(['dist/', '.yarn/'])
])
