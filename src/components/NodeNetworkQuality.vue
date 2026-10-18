<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useNodesStore } from '@/stores/nodes'
import { formatDateTime } from '@/utils/helper'
import { buildNetworkBars, THREE_NETWORKS, validNetworkValue } from '@/utils/networkQuality'
import { getPingToneClass } from '@/utils/nodeHelper'

const props = withDefaults(defineProps<{ node: NodeData, compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ open: [] }>()
const nodesStore = useNodesStore()

function activate(event: Event) {
  if (props.compact)
    return
  event.stopPropagation()
  event.preventDefault()
  emit('open')
}

const rows = computed(() => {
  const history = nodesStore.pingHistoryByUuid[props.node.uuid] ?? []
  return THREE_NETWORKS.map((provider) => {
    const current = props.node.ping?.[provider.key]
    const latency = validNetworkValue(current?.latencyAvailable === false ? null : current?.latest, 'latency')
    const loss = validNetworkValue(current?.lossAvailable === false ? null : current?.loss, 'loss')
    return {
      key: provider.key,
      name: current?.name || provider.label,
      latency: latency === null || loss === 100 ? '--' : Math.round(latency).toString(),
      loss: loss === null ? '--' : loss.toFixed(1),
      latencyTone: getPingToneClass(latency ?? 0, latency !== null && loss !== 100),
      lossTone: loss === null ? 'text-muted-foreground' : loss <= 1 ? 'text-emerald-600 dark:text-emerald-400' : loss <= 9 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400',
      metrics: [
        { key: 'latency', label: '延迟', unit: 'ms', bars: buildNetworkBars(history, provider.key, 'latency') },
        { key: 'loss', label: '丢包', unit: '%', bars: buildNetworkBars(history, provider.key, 'loss') },
      ],
    }
  })
})
</script>

<template>
  <div
    :role="compact ? undefined : 'button'" :tabindex="compact ? undefined : 0" data-testid="network-quality"
    class="network-quality min-w-0 w-full cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :class="compact ? 'space-y-1.5' : 'space-y-2.5 border-t border-border/60 pt-2.5'"
    :aria-label="`${props.node.name} 三网延迟和丢包详情`"
    @click="activate"
    @keydown.enter="activate"
    @keydown.space="activate"
  >
    <div v-for="row in rows" :key="row.key" class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-1" :data-network="row.key">
      <div class="flex min-w-0 items-baseline justify-between gap-1" :class="compact ? 'text-[10px]' : 'text-[11px]'">
        <span class="min-w-0 truncate font-medium text-muted-foreground" :title="row.name">{{ row.name }}</span>
        <span class="shrink-0 tabular-nums font-semibold" :class="row.latencyTone">{{ row.latency }}<span class="ml-0.5 font-normal text-muted-foreground">ms</span></span>
      </div>
      <div class="flex min-w-0 items-baseline justify-end tabular-nums" :class="compact ? 'text-[10px]' : 'text-[11px]'">
        <span class="font-semibold" :class="row.lossTone">{{ row.loss }}<span class="ml-0.5 font-normal text-muted-foreground">%</span></span>
      </div>
      <div
        v-for="metric in row.metrics" :key="metric.key" class="grid min-w-0 grid-cols-20"
        :class="compact ? 'h-1 gap-px' : 'h-1.5 gap-[2px]'" :aria-label="`${row.name} ${metric.label}近期采样`"
      >
        <DataTooltip
          v-for="bar in metric.bars" :key="bar.key" class="h-full w-full"
          :content="`${row.name} · ${metric.label}\n${bar.time ? formatDateTime(bar.time, 'HH:mm') : ''}\n${bar.value === null ? '无采样' : `${bar.value.toFixed(metric.key === 'loss' ? 1 : 0)} ${metric.unit}`}`"
          content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.3] text-[11px]"
        >
          <span class="block h-full w-full rounded-[1px]" :class="bar.className" />
        </DataTooltip>
      </div>
    </div>
  </div>
</template>
