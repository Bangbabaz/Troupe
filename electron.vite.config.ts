import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // worker bundle 用 ES 输出 —— shiki worker 内部走动态 import 按需加载语言 grammar，
    // 默认的 iife format 不支持 code-splitting。
    worker: {
      format: 'es'
    },
    css: {
      preprocessorOptions: {
        scss: {
          // Auto-inject SCSS mixins/$variables (zero CSS output) into every
          // <style lang="scss"> so components use @include/$font-* without an
          // explicit @use. Runtime color tokens are global CSS vars, not here.
          additionalData: `@use "@renderer/assets/style/abstracts" as *;\n`
        }
      }
    },
    plugins: [
      vue(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
        eslintrc: {
          enabled: true,
          filepath: './.eslintrc-auto-import.json'
        }
      }),
      Components({
        resolvers: [ElementPlusResolver({ importStyle: 'css' })]
      })
    ]
  }
})
