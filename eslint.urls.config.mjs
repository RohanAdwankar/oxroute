import parser from '@typescript-eslint/parser';
import boundaries from './scripts/eslint/url-boundaries.mjs';

const config = [{
  files: ['app/**/*.{ts,tsx}'],
  languageOptions: {parser, parserOptions: {ecmaFeatures: {jsx: true}}},
  plugins: {boundaries: {rules: {'url-parsing': boundaries}}},
  rules: {'boundaries/url-parsing': 'error'},
}];

export default config;
