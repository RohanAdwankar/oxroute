import {RuleTester, ESLint} from 'eslint';
import parser from '@typescript-eslint/parser';
import rule from '../scripts/eslint/url-boundaries.mjs';

const tester = new RuleTester({languageOptions: {parser, parserOptions: {ecmaFeatures: {jsx: true}}}});
const error = {messageId: 'unguarded'};
tester.run('url-parsing', rule, {
  valid: [
    'function parse(input: string) { try { return new URL(input); } catch { return null; } }',
    'function decode(input) { try { return decodeURIComponent(input); } catch { return null; } }',
    'try { decodeURI(value); } catch { report(); }',
    'new URL("https://example.invalid/path")',
    'new URL("../worker.ts", import.meta.url)',
    'new URL(window.location.href)',
    'new URL(location.origin)',
    'decodeURIComponent("safe%20text")',
    'function custom(URL) { return new URL(value); }',
    'function custom(decodeURI) { return decodeURI(value); }',
  ],
  invalid: [
    {code: 'function render({href}) { return new URL(href); }', errors: [error]},
    {code: 'const render = ({href}) => <a>{decodeURIComponent(href)}</a>;', errors: [error]},
    {code: 'try { setTimeout(() => new URL(input)); } catch {}', errors: [error]},
    {code: 'try { work(); } catch { decodeURI(value); }', errors: [error]},
    {code: 'try { work(); } finally { new URL(input); }', errors: [error]},
    {code: 'try { new URL(input); } finally { cleanup(); }', errors: [error]},
    {code: 'new URL("https://[invalid")', errors: [error]},
    {code: 'decodeURIComponent("%")', errors: [error]},
    {code: 'decodeURIComponent(location.href)', errors: [error]},
    {code: 'new URL("/path", userBase)', errors: [error]},
    {code: 'new globalThis.URL(input)', errors: [error]},
    {code: 'window.decodeURIComponent(input)', errors: [error]},
    {code: 'function parse(window) { return new URL(window.location.href); }', errors: [error]},
  ],
});
// The production check must reject a new unsafe parser in a component.
const lint = new ESLint({overrideConfigFile: 'eslint.urls.config.mjs', allowInlineConfig: false});
const [bad] = await lint.lintText('export const Preview = ({href}: {href: string}) => <span>{new URL(href).pathname}</span>;', {filePath: 'app/components/Preview.tsx'});
if (bad.errorCount !== 1 || bad.messages[0].ruleId !== 'boundaries/url-parsing') throw new Error('URL boundary lint was not enforced');
const [good] = await lint.lintText('export function parse(href: string) {try {return new URL(href);} catch {return null;}}', {filePath: 'app/lib/links.ts'});
if (good.errorCount) throw new Error(JSON.stringify(good.messages));
console.log('URL boundary lint rejects unhandled parsing, invalid literals and deferred callbacks; guarded parsing and trusted browser URLs pass.');
