import { readFileSync } from 'fs'
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const autoImportGlobals = (() => {
  try {
    const raw = readFileSync(new URL('./.eslintrc-auto-import.json', import.meta.url), 'utf8')
    return JSON.parse(raw).globals || {}
  } catch {
    return {}
  }
})()

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    languageOptions: {
      globals: {
        ...autoImportGlobals
      }
    },
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/components/DiffViewer.vue'],
    rules: {
      // Shiki token HTML is generated locally; fallback text is escaped before rendering.
      'vue/no-v-html': 'off'
    }
  },
  eslintConfigPrettier
)
