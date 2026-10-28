import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['node_modules/**','dist/**','.llmesh/**','src/ui/assets/**','src/contracts/**','models/**'] },
  js.configs.recommended,
  { files: ['**/*.js','**/*.cjs'], languageOptions: { globals: {...globals.node,...globals.browser} }, rules: {
    'no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_',ignoreRestSiblings:true}],
    'no-empty':['error',{allowEmptyCatch:true}]
  } },
  { files: ['src/core/**/*.js'], languageOptions: { parser: tseslint.parser, parserOptions: {project:'./tsconfig.json'} }, plugins:{'@typescript-eslint':tseslint.plugin},
    rules: {'@typescript-eslint/no-floating-promises':['error',{ignoreVoid:true}], 'no-restricted-imports':['error',{paths:[{name:'electron',message:'Core must remain headless.'}]}]} }
];
