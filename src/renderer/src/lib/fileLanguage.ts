const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'mdx',
  sql: 'sql',
  dockerfile: 'dockerfile',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  lua: 'lua',
  php: 'php',
  r: 'r',
  makefile: 'makefile',
  cmake: 'cmake',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto'
}

export function detectFileLanguage(filename: string): string | null {
  const base = filename.replace(/\\/g, '/').split('/').pop() || filename
  const lower = base.toLowerCase()
  if (LANGUAGE_MAP[lower]) return LANGUAGE_MAP[lower]
  const dot = base.lastIndexOf('.')
  if (dot < 0) return null
  return LANGUAGE_MAP[base.slice(dot + 1).toLowerCase()] || null
}
