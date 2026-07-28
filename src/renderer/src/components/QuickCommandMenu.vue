<script setup lang="ts">
import { ref } from 'vue'
import { CornerDownLeft, Pencil, Zap } from 'lucide-vue-next'
import type { QuickCommand } from '@shared/types'

defineProps<{
  commands: QuickCommand[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  run: [command: QuickCommand, execute: boolean]
  manage: []
}>()

const visible = ref(false)

function choose(command: QuickCommand, execute: boolean): void {
  visible.value = false
  emit('run', command, execute)
}

function manage(): void {
  visible.value = false
  emit('manage')
}
</script>

<template>
  <el-popover
    v-model:visible="visible"
    placement="bottom-end"
    :width="228"
    trigger="click"
    popper-class="quick-command-popper"
  >
    <template #reference>
      <button class="quick-command-trigger" title="快捷指令" :disabled="disabled">
        <Zap :size="14" />
      </button>
    </template>

    <div class="quick-command-menu">
      <div v-if="commands.length" class="quick-command-list">
        <div v-for="item in commands" :key="item.id" class="quick-command-row">
          <button class="quick-command-main" :title="item.command" @click="choose(item, true)">
            <span>{{ item.name || item.command }}</span>
          </button>
          <button class="quick-command-paste" title="仅填入" @click="choose(item, false)">
            <CornerDownLeft :size="13" />
          </button>
        </div>
      </div>
      <div v-else class="quick-command-empty">暂无指令</div>
      <button class="quick-command-manage" @click="manage">
        <Pencil :size="12" />
        管理
      </button>
    </div>
  </el-popover>
</template>

<style scoped lang="scss">
.quick-command-trigger {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  color: var(--el-text-color-regular);
  border-radius: $radius;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--el-text-color-primary);
    background: color-mix(in srgb, var(--el-text-color-primary) 8%, transparent);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.quick-command-menu,
.quick-command-list {
  display: flex;
  flex-direction: column;
}

.quick-command-menu {
  gap: 3px;
  @include ui-font;
}

.quick-command-list {
  gap: 1px;
}

.quick-command-row {
  display: flex;
  min-width: 0;
  border-radius: $radius-sm;

  &:hover {
    background: color-mix(in srgb, var(--el-text-color-primary) 7%, transparent);
  }
}

.quick-command-main,
.quick-command-paste,
.quick-command-manage {
  @include btn-reset;
  color: var(--el-text-color-regular);
  cursor: pointer;
}

.quick-command-main {
  min-width: 0;
  height: 30px;
  flex: 1;
  padding: 0 9px;
  text-align: left;

  span {
    display: block;
    overflow: hidden;
    color: var(--el-text-color-primary);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.quick-command-paste {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  flex-shrink: 0;
  border-left: 1px solid transparent;
  border-radius: 0 $radius-sm $radius-sm 0;
  opacity: 0;

  &:hover {
    color: var(--el-color-primary);
    border-left-color: var(--el-border-color);
    background: var(--el-fill-color);
  }
}

.quick-command-row:hover .quick-command-paste,
.quick-command-paste:focus-visible {
  opacity: 1;
}

.quick-command-empty {
  padding: 12px 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}

.quick-command-manage {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding: 6px 8px 1px;
  border-top: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  font-size: 11px;

  &:hover {
    color: var(--el-color-primary);
  }
}
</style>
