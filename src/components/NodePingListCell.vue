<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import NodeNetworkQuality from '@/components/NodeNetworkQuality.vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { buildTopPingNetworks } from '@/composables/useNodePingDisplay'
import { useNodesStore } from '@/stores/nodes'

const props = defineProps<{ node: NodeData }>()

const nodesStore = useNodesStore()
const topPingNetworks = computed(() => buildTopPingNetworks(props.node.ping))
</script>

<template>
  <div class="flex min-w-0 w-full flex-col">
    <NodeNetworkQuality v-if="nodesStore.showThreeNetDetails" :node="props.node" compact />
    <div v-else-if="topPingNetworks.length > 0" class="flex flex-row">
      <DataTooltip
        v-for="(net, index) in topPingNetworks" :key="net.key" placement="top"
        :content="net.tooltip"
        content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
      >
        <div class="truncate text-[10px]">
          <span v-if="index" class="mx-1">·</span>
          <span :class="net.toneClass">{{ net.latency }}</span>
        </div>
      </DataTooltip>
    </div>
    <div v-else class="truncate">
      N/A
    </div>
  </div>
</template>
