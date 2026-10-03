import { type CSSProperties, useEffect, useState } from 'react';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/bash.mjs';
import css from 'shiki/langs/css.mjs';
import html from 'shiki/langs/html.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import python from 'shiki/langs/python.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import dark from 'shiki/themes/github-dark-high-contrast.mjs';
import light from 'shiki/themes/github-light-high-contrast.mjs';

export type AgentCodeLanguage = 'bash' | 'css' | 'html' | 'javascript' | 'json' | 'jsx' | 'python' | 'tsx' | 'typescript' | 'yaml' | 'text';
type CodeToken = { content: string; offset: number; light?: string; dark?: string };
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;

export function fileLanguage(file: string): AgentCodeLanguage {
  const ext = file.split('.').at(-1)?.toLowerCase() ?? '';
  const languages: Record<string, AgentCodeLanguage> = {
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', css: 'css', html: 'html', htm: 'html', yaml: 'yaml', yml: 'yaml',
  };
  return languages[ext] ?? 'text';
}

export function useAgentCodeTokens(code: string, language: AgentCodeLanguage) {
  const [result, setResult] = useState<{ code: string; language: AgentCodeLanguage; lines: CodeToken[][] }>();
  useEffect(() => {
    if (language === 'text' || !code) return;
    let cancelled = false;
    highlighter ??= createHighlighterCore({
      themes: [light, dark],
      langs: [bash, css, html, javascript, json, jsx, python, tsx, typescript, yaml],
      engine: createJavaScriptRegexEngine(),
    });
    void highlighter.then((h) => {
      if (cancelled) return;
      const lines = h.codeToTokensWithThemes(code, {
        lang: language, themes: { light: light.name!, dark: dark.name! },
      }).map((line) => line.map((token) => ({
        content: token.content, offset: token.offset, light: token.variants.light?.color, dark: token.variants.dark?.color,
      })));
      setResult({ code, language, lines });
    }).catch(() => { if (!cancelled) setResult(undefined); });
    return () => { cancelled = true; };
  }, [code, language]);
  return result?.code === code && result.language === language ? result.lines : undefined;
}

export function AgentCodeLine({ code, tokens }: { code: string; tokens?: CodeToken[] }) {
  return <span className="whitespace-pre px-1.5">{tokens ? tokens.map((token) => (
    <span key={token.offset} style={{ '--agent-code-light': token.light ?? 'currentColor', '--agent-code-dark': token.dark ?? token.light ?? 'currentColor' } as CSSProperties}
      className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]">{token.content}</span>
  )) : code || ' '}</span>;
}

export function AgentCode({ code, language = 'text' }: { code: string; language?: AgentCodeLanguage }) {
  const lines = useAgentCodeTokens(code, language);
  const rows = code.split('\n');
  return <pre className="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-5">{rows.map((line, i) => (
    <span key={i}>{lines?.[i] ? lines[i]!.map((token) => (
      <span key={token.offset} style={{ '--agent-code-light': token.light ?? 'currentColor', '--agent-code-dark': token.dark ?? token.light ?? 'currentColor' } as CSSProperties}
        className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]">{token.content}</span>
    )) : line}{i < rows.length - 1 ? '\n' : ''}</span>
  ))}</pre>;
}
