<script setup lang="ts">
import type { PingChartRecord as PingRecord } from '@/utils/pingChart'
import { Icon } from '@iconify/vue'
import dayjs from 'dayjs'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import VChart from 'vue-echarts'
import LongHistoryLoginDialog from '@/components/LongHistoryLoginDialog.vue'
import { Button } from '@/components/ui/button'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { Empty } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { getGuestMaxChartTimeRangeLabel, requiresLongHistoryLogin, showLongHistoryLoginPrompt } from '@/composables/useLongHistoryAuth'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { DEFAULT_CHART_TIME_RANGE, getAvailableChartTimeRanges } from '@/utils/chartTimeRange'
import { buildPingMetricAxes, buildPingMetricSeries, lossKey, mergePingChartRecords, pingMetric, preparePingChartRows } from '@/utils/pingChart'
import { getSharedRpc, RpcError } from '@/utils/rpc'
import '@/utils/echarts' // 共享 ECharts 配置

const props = defineProps<{
  uuid: string
}>()

const appStore = useAppStore()
const { pickSurfaceClass } = useBackgroundSurface()
const nodesStore = useNodesStore()
const nodeInfo = computed(() => nodesStore.nodesByUuid.get(props.uuid))
const isDark = computed(() => appStore.isDark)
// 使用共享的 RPC 实例，避免重复创建连接
const rpc = getSharedRpc()

// 图表主题相关颜色
const chartThemeColors = computed(() => ({
  text: isDark.value ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)',
  textSecondary: isDark.value ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.55)',
  textTertiary: isDark.value ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
  borderColor: isDark.value ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
  splitLineColor: isDark.value ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)',
  tooltipBg: isDark.value ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.8)',
  tooltipShadow: isDark.value ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.06)',
  crosshairColor: isDark.value ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
}))

// 优化后的图表配色方案（多任务时使用）
const chartColors = [
  '#FF6B6B', // 珊瑚红
  '#4ECDC4', // 青绿色
  '#A78BFA', // 紫罗兰
  '#60A5FA', // 天蓝色
  '#FFB347', // 琥珀黄
  '#F472B6', // 粉红色
  '#34D399', // 翠绿色
  '#FB923C', // 橙色
]

// 从 publicSettings 获取记录保留时间
const maxPingRecordPreserveTime = computed(() => appStore.publicSettings?.ping_record_preserve_time || 168)

// 可用视图列表
const availableViews = computed(() => getAvailableChartTimeRanges(maxPingRecordPreserveTime.value))

// 当前选中的视图
const selectedView = ref<string>(DEFAULT_CHART_TIME_RANGE.label)
const selectedHours = computed(() => {
  const view = availableViews.value.find(v => v.label === selectedView.value)
  return view?.hours ?? DEFAULT_CHART_TIME_RANGE.hours
})
const lastCommittedView = ref<string>(DEFAULT_CHART_TIME_RANGE.label)

// 初始化默认视图
watch(availableViews, (views) => {
  if (!views.some(view => view.label === selectedView.value))
    selectedView.value = views[0]?.label ?? DEFAULT_CHART_TIME_RANGE.label
}, { immediate: true })

// ==================== 类型定义 ====================

interface TaskInfo {
  id: number
  key?: string
  name: string
  interval?: number
  loss?: number
  p99?: number
  p50?: number
  p99_p50_ratio?: number
  min?: number
  max?: number
  avg?: number
  latest?: number
  total?: number
  type?: string
}

interface MetricPoint {
  time: string
  value: number | null
  tags?: Record<string, string>
  tag?: Record<string, string>
}

interface MetricSeries {
  metric_key: 'ping.latency_ms' | 'ping.loss'
  tags?: Record<string, string>
  tag?: Record<string, string>
  points: MetricPoint[]
}

interface MetricQueryResponse {
  series: MetricSeries[]
}

interface PingMetricTaskStats {
  task_id: string
  name?: string
  type?: string
  interval?: number
  loss?: number
  min?: number
  max?: number
  avg?: number
  latest?: number
  total?: number
  p50?: number
  p99?: number
  p99_p50_ratio?: number
}

interface PingMetricStatsResponse {
  stats: PingMetricTaskStats[]
}

interface PingRecordsResponse {
  records: PingRecord[]
  tasks?: TaskInfo[]
}

interface PingChartData {
  records: PingRecord[]
  tasks: TaskInfo[]
}

// 数据状态
const remoteData = shallowRef<PingRecord[]>([])
const tasks = shallowRef<TaskInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let fetchRequestId = 0
let metricRpcSupported: boolean | null = null

// 任务选择
const selectedTaskIds = ref<number[]>([])
const cutPeak = ref(false)
const showDelay = ref(true)
const showLoss = ref(true)
const chartMargin = { top: 30, right: 24, bottom: 52, left: 56 }

const mergeToleranceMs = computed(() => {
  const taskIntervals = tasks.value
    .map(t => t.interval)
    .filter((v): v is number => typeof v === 'number' && v > 0)

  const fallbackIntervalSec = taskIntervals.length ? Math.min(...taskIntervals) : 60
  return Math.min(
    6000,
    Math.max(800, Math.floor(fallbackIntervalSec * 1000 * 0.25)),
  )
})

// ==================== 数据获取 ====================

function isMethodNotFoundError(err: unknown): boolean {
  return err instanceof RpcError && err.code === -32601
}

function getMetricTaskId(series: MetricSeries, point: MetricPoint): number | null {
  const taskId = Number(
    point.tags?.task_id
    ?? series.tags?.task_id
    ?? point.tag?.task_id
    ?? series.tag?.task_id,
  )

  return Number.isInteger(taskId) ? taskId : null
}

async function fetchMetricRecords(uuid: string, hours: number): Promise<PingChartData> {
  const [metricResult, statsResult] = await Promise.all([
    rpc.getClient().call<MetricQueryResponse>('public:queryMetrics', {
      metric_keys: ['ping.latency_ms', 'ping.loss'],
      entity_id: uuid,
      hours,
      downsample: true,
      max_points: 500,
      aggregation: 'avg',
    }),
    rpc.getClient().call<PingMetricStatsResponse>('public:getPingMetricStats', {
      uuid,
      hours,
      max_points: 500,
    }),
  ])

  const records: PingRecord[] = []
  for (const series of metricResult?.series ?? []) {
    for (const point of series.points ?? []) {
      const taskId = getMetricTaskId(series, point)
      if (taskId === null)
        continue

      if (point.value === null)
        continue

      records.push({
        client: uuid,
        task_id: taskId,
        time: point.time,
        value: series.metric_key === 'ping.loss' ? -1 : point.value,
        loss: series.metric_key === 'ping.loss' ? point.value : undefined,
        metric: series.metric_key === 'ping.loss' ? 'loss' : 'latency',
      })
    }
  }

  const metricTasks = (statsResult?.stats ?? []).map(task => ({
    id: Number(task.task_id),
    name: task.name || `Ping ${task.task_id}`,
    interval: task.interval,
    loss: task.loss,
    p99: task.p99,
    p50: task.p50,
    p99_p50_ratio: task.p99_p50_ratio,
    min: task.min,
    max: task.max,
    avg: task.avg,
    latest: task.latest,
    total: task.total,
    type: task.type,
  })).filter(task => Number.isInteger(task.id))

  const fallbackTasks = Array.from(new Set(records.map(record => record.task_id)), taskId => ({
    id: taskId,
    name: `Ping ${taskId}`,
  }))

  return { records, tasks: metricTasks.length ? metricTasks : fallbackTasks }
}

async function fetchLegacyRecords(uuid: string, hours: number): Promise<PingChartData> {
  const result = await rpc.getClient().call<PingRecordsResponse>('common:getRecords', {
    type: 'ping',
    uuid,
    hours,
  })

  return {
    records: result?.records ?? [],
    tasks: result?.tasks ?? [],
  }
}

async function fetchRecords() {
  if (!props.uuid)
    return

  const requestId = ++fetchRequestId
  const uuid = props.uuid
  const hours = selectedHours.value

  loading.value = true
  error.value = null

  try {
    let result: PingChartData
    if (metricRpcSupported === false) {
      result = await fetchLegacyRecords(uuid, hours)
    }
    else {
      try {
        result = await fetchMetricRecords(uuid, hours)
        metricRpcSupported = true
      }
      catch (err) {
        if (!isMethodNotFoundError(err))
          throw err

        metricRpcSupported = false
        result = await fetchLegacyRecords(uuid, hours)
      }
    }

    if (requestId !== fetchRequestId)
      return

    const records = result.records
    records.sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf())

    remoteData.value = records
    tasks.value = result.tasks

    if (tasks.value.length > 0 && selectedTaskIds.value.length === 0) {
      selectedTaskIds.value = tasks.value.map(t => t.id)
    }
  }
  catch (err) {
    if (requestId !== fetchRequestId)
      return

    error.value = err instanceof Error ? err.message : '获取数据失败'
    remoteData.value = []
    tasks.value = []
  }
  finally {
    if (requestId === fetchRequestId) {
      loading.value = false
    }
  }
}

// ==================== 数据处理 ====================

const mergedData = computed(() => mergePingChartRecords(remoteData.value, mergeToleranceMs.value, selectedHours.value))
const chartData = computed(() => preparePingChartRows(mergedData.value, selectedTaskIds.value, cutPeak.value))

function setDelay(event: Event) {
  showDelay.value = (event.target as HTMLInputElement).checked
  if (!showDelay.value)
    cutPeak.value = false
}

function setSmoothing(event: Event) {
  cutPeak.value = (event.target as HTMLInputElement).checked
  if (cutPeak.value)
    showDelay.value = true
}

// ==================== 工具函数 ====================

function formatTime(time: string, showDate: boolean): string {
  const date = dayjs(time)
  if (showDate) {
    return date.format('M/D HH:mm')
  }
  return date.format('HH:mm')
}

function formatTimeForTooltip(time: string, hours: number): string {
  const date = dayjs(time)
  if (hours < 24) {
    return date.format('HH:mm:ss')
  }
  return date.format('MM/DD HH:mm')
}

const showDateInAxis = computed(() => selectedHours.value >= 24)

// ==================== 任务选择 ====================

// 获取任务颜色（根据任务在完整列表中的索引）
function getTaskColor(taskId: number): string {
  const taskIndex = tasks.value.findIndex(t => t.id === taskId)
  const safeIndex = Math.max(0, taskIndex % chartColors.length)
  return chartColors[safeIndex]!
}

function finiteMetric(value: unknown): number | undefined {
  return pingMetric(value)
}

function average(values: number[]): number | undefined {
  if (!values.length)
    return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], ratio: number): number | undefined {
  if (!values.length)
    return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function sampleIntervalSeconds(records: PingRecord[]): number | undefined {
  const timestamps = [...new Set(records.map(record => dayjs(record.time).valueOf()))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (timestamps.length < 2)
    return undefined

  const deltas = timestamps.slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]!)
    .filter(delta => delta > 0)
    .sort((a, b) => a - b)
  if (!deltas.length)
    return undefined
  const seconds = Math.round(deltas[Math.floor(deltas.length / 2)]! / 1000)
  return seconds > 0 ? seconds : undefined
}

// 优先使用当前查询周期内的原始样本，缺少时才回退到接口聚合字段。
const latestValues = computed(() => {
  if (!tasks.value.length)
    return []

  return tasks.value.map((task, idx) => {
    const taskRecords = remoteData.value.filter(record => record.task_id === task.id)
    const latencyRecords = taskRecords.filter(record => record.metric !== 'loss' && record.value >= 0)
    const latencyValues = latencyRecords.map(record => record.value)
    const lossValues = taskRecords
      .map(record => finiteMetric(record.loss))
      .filter((value): value is number => value !== undefined)
    const latest = latencyValues.at(-1)
    const p50 = percentile(latencyValues, 0.5)
    const p99 = percentile(latencyValues, 0.99)

    const safeIdx = Math.max(0, idx % chartColors.length)
    return {
      ...task,
      min: latencyValues.length ? Math.min(...latencyValues) : finiteMetric(task.min),
      max: latencyValues.length ? Math.max(...latencyValues) : finiteMetric(task.max),
      avg: average(latencyValues) ?? finiteMetric(task.avg),
      latest: latest ?? finiteMetric(task.latest),
      p50: p50 ?? finiteMetric(task.p50),
      p99: p99 ?? finiteMetric(task.p99),
      p99_p50_ratio: p50 && p99 ? p99 / p50 : finiteMetric(task.p99_p50_ratio),
      interval: sampleIntervalSeconds(latencyRecords) ?? finiteMetric(task.interval),
      loss: average(lossValues) ?? finiteMetric(task.loss),
      total: latencyRecords.length || finiteMetric(task.total),
      latestValue: latest ?? finiteMetric(task.latest) ?? null,
      color: chartColors[safeIdx]!,
    }
  })
})

const selectedTasks = computed(() => {
  return tasks.value.filter(t => selectedTaskIds.value.includes(t.id))
})

const PING_TASK_KEYS: Record<number, string> = {
  1: 'ct',
  2: 'cu',
  3: 'cm',
  4: 'bd',
  5: 'node_1',
  6: 'node_2',
  7: 'node_3',
  8: 'node_4',
}

function appendRealtimePing(node: NonNullable<typeof nodeInfo.value>): void {
  if (selectedView.value !== DEFAULT_CHART_TIME_RANGE.label || !node.time || !node.ping)
    return

  const time = node.time
  const taskIds = tasks.value.map(task => task.id)
  const records = taskIds.flatMap((taskId) => {
    const key = tasks.value.find(task => task.id === taskId)?.key ?? PING_TASK_KEYS[taskId]
    const ping = key ? node.ping?.[key] : undefined
    if (!ping)
      return []

    return [{
      client: node.uuid,
      task_id: taskId,
      time,
      value: ping.latencyAvailable !== false && ping.latest > 0 ? ping.latest : -1,
      loss: ping.lossAvailable !== false ? ping.loss : undefined,
      metric: 'latency' as const,
    }]
  })

  if (!records.length)
    return

  const recordKeys = new Set(records.map(record => `${record.task_id}:${record.time}`))
  const existing = remoteData.value.filter(record => !recordKeys.has(`${record.task_id}:${record.time}`))
  remoteData.value = [...existing, ...records]
    .sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf())
    .slice(-500)
}

// 切换任务选中状态
function toggleTask(taskId: number) {
  if (selectedTaskIds.value.includes(taskId)) {
    selectedTaskIds.value = selectedTaskIds.value.filter(id => id !== taskId)
  }
  else {
    selectedTaskIds.value = [...selectedTaskIds.value, taskId]
  }
}

function showAllTasks() {
  selectedTaskIds.value = tasks.value.map(t => t.id)
}

function hideAllTasks() {
  selectedTaskIds.value = []
}

// ==================== 图表配置 ====================

// 通用 Tooltip 配置
const baseTooltipConfig = computed(() => ({
  trigger: 'axis' as const,
  confine: false,
  backgroundColor: chartThemeColors.value.tooltipBg,
  borderColor: 'transparent',
  borderWidth: 0,
  borderRadius: 6,
  textStyle: {
    color: chartThemeColors.value.text,
    fontSize: 12,
    lineHeight: 20,
  },
  extraCssText: `backdrop-filter: blur(5px);z-index:9;box-shadow:0 0 0 1px ${chartThemeColors.value.tooltipShadow}, 0 0 16px ${chartThemeColors.value.tooltipShadow}`,
  axisPointer: {
    type: 'cross' as const,
    crossStyle: {
      color: chartThemeColors.value.textTertiary,
    },
    lineStyle: {
      color: chartThemeColors.value.crosshairColor,
      width: 1,
      type: 'dashed' as const,
    },
    shadowStyle: {
      color: chartThemeColors.value.crosshairColor,
    },
  },
}))

const pingChartOption = computed(() => {
  const taskList = selectedTasks.value
  const data = chartData.value
  const hours = selectedHours.value

  const series = buildPingMetricSeries(taskList, data, {
    showDelay: showDelay.value,
    showLoss: showLoss.value,
    smooth: cutPeak.value,
    colorFor: getTaskColor,
  })

  return {
    animation: false,
    // 全局颜色设置（用于图例等）
    color: tasks.value.map((_, idx) => {
      const safeIdx = Math.max(0, idx % chartColors.length)
      return chartColors[safeIdx]!
    }),
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ seriesId: string, dataIndex: number }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const rowData = data[firstParam.dataIndex]
        if (!rowData)
          return ''

        const time = rowData.time as string
        const timeStr = formatTimeForTooltip(time, hours)
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'

        for (const task of taskList) {
          if (!p.some(item => item.seriesId === `latency-${task.id}` || item.seriesId === `loss-${task.id}`))
            continue
          const latency = finiteMetric(rowData[task.id])
          const loss = finiteMetric(rowData[lossKey(task.id)])
          const values = [
            ...(showDelay.value ? [latency === undefined ? '-- ms' : `${Math.round(latency)} ms`] : []),
            ...(showLoss.value ? [loss === undefined ? '-- %' : `${loss.toFixed(2)} %`] : []),
          ]
          const name = task.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${getTaskColor(task.id)};margin-right:8px;flex-shrink:0"></span>`
          html += `<div style="display:flex;align-items:center;gap:8px">${colorDot}<span style="flex:1;white-space:nowrap">${name}</span><span style="font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap">${values.join(' · ')}</span></div>`
        }
        html += '</div>'
        return html
      },
    },
    legend: {
      type: 'scroll',
      bottom: 0,
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 16,
      icon: 'roundRect',
      textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
      data: taskList.map(t => t.name),
    },
    grid: { ...chartMargin, right: showDelay.value && showLoss.value ? 60 : chartMargin.right },
    xAxis: {
      type: 'category',
      data: data.map(d => formatTime(d.time as string, showDateInAxis.value)),
      axisLabel: {
        fontSize: 11,
        color: chartThemeColors.value.textSecondary,
        margin: 12,
      },
      axisLine: {
        show: true,
        lineStyle: { color: chartThemeColors.value.borderColor, width: 1 },
      },
      axisTick: { show: false },
      boundaryGap: false,
    },
    yAxis: buildPingMetricAxes(showDelay.value, showLoss.value).map((axis, index) => ({
      ...axis,
      type: 'value',
      nameTextStyle: { color: chartThemeColors.value.textSecondary },
      axisLabel: { fontSize: 11, color: chartThemeColors.value.textSecondary, formatter: index === 1 ? '{value}%' : '{value}' },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: {
        show: index === 0 || !showDelay.value,
        lineStyle: {
          color: chartThemeColors.value.splitLineColor,
          type: 'dashed' as const,
        },
      },
    })),
    series,
  }
})

// ==================== 生命周期 ====================

watch(selectedView, (label) => {
  const hours = availableViews.value.find(v => v.label === label)?.hours ?? DEFAULT_CHART_TIME_RANGE.hours
  if (requiresLongHistoryLogin(hours) && !appStore.isLoggedIn) {
    selectedView.value = lastCommittedView.value || getGuestMaxChartTimeRangeLabel()
    showLongHistoryLoginPrompt()
    return
  }
  lastCommittedView.value = label
  selectedTaskIds.value = []
  fetchRecords()
})

watch(() => props.uuid, () => {
  remoteData.value = []
  tasks.value = []
  selectedTaskIds.value = []
  fetchRecords()
})

watch(nodeInfo, (node) => {
  if (node)
    appendRealtimePing(node)
})

onMounted(() => {
  fetchRecords()
})
</script>

<template>
  <div data-testid="ping-chart" class="flex flex-col gap-4">
    <LongHistoryLoginDialog />
    <!-- 时间选择器 -->
    <Tabs v-model="selectedView" class="w-full items-center">
      <div class="min-w-0 flex-1 overflow-x-auto pointer-events-auto">
        <TabsList :class="pickSurfaceClass('w-max h-8 bg-background/60 rounded-md', 'w-max h-8 bg-background/50 backdrop-blur-xl rounded-md')">
          <TabsTrigger
            v-for="view in availableViews" :key="view.label" :value="view.label"
            class="h-6.5 flex-none shrink-0 text-xs border-none data-[state=active]:text-emerald-600 shadow-none rounded-sm"
          >
            {{ view.label }}
          </TabsTrigger>
        </TabsList>
      </div>
      <div class="md:flex-1" />
      <div class="flex gap-2 items-center">
        <Button
          variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
          :class="[selectedTaskIds.length === tasks.length && 'bg-background !text-emerald-600']"
          @click="showAllTasks"
        >
          全选
        </Button>
        <Button
          variant="ghost" size="xs" class="h-7 rounded-sm border-none bg-background/60 hover:bg-background"
          :class="[!selectedTaskIds.length && 'bg-background !text-emerald-600']"
          @click="hideAllTasks"
        >
          全不选
        </Button>
      </div>
    </Tabs>

    <!-- 内容区域 -->
    <Spinner :show="loading" content-class="flex flex-col gap-4">
      <div v-if="error" class="text-red-500 py-8 text-center">
        {{ error }}
      </div>
      <div v-else-if="tasks.length === 0 && !loading" class="py-8">
        <Empty description="暂无延迟数据" />
      </div>

      <template v-else>
        <!-- 最新值统计卡片（可点击切换选中状态） -->
        <div
          v-if="latestValues.length > 0" class="gap-3 grid"
          style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))"
        >
          <div
            v-for="task in latestValues" :key="task.id"
            class="flex cursor-pointer select-none items-center gap-3 rounded-md p-2 transition-all bg-background/60 hover:bg-background hover:shadow-[0_0_0_1px] hover:shadow-emerald-600/10"
            :class="[
              !selectedTaskIds.includes(task.id) && 'opacity-30',
            ]"
            :onmouseover="(e: MouseEvent) => ((e.currentTarget as HTMLElement).style.borderColor = task.color)"
            :onmouseout="(e: MouseEvent) => ((e.currentTarget as HTMLElement).style.borderColor = '')"
            @click="toggleTask(task.id)"
          >
            <div class="flex-1 min-w-0">
              <div class="flex gap-2 items-center">
                <div class="rounded h-4 w-1" :style="{ backgroundColor: task.color }" />
                <span class="text-sm font-semibold truncate">{{ task.name }}</span>
                <div class="flex-1" />
                <DataTooltip placement="left" content-class="!rounded p-3 w-60 backdrop-blur">
                  <Button variant="ghost" size="icon-xs" class="text-slate-500" @click.stop>
                    <Icon icon="carbon:information" :width="14" :height="14" />
                  </Button>
                  <template #content>
                    <div class="text-xs gap-x-4 gap-y-1.5 grid grid-cols-4">
                      <template v-if="task.min !== undefined">
                        <span class="text-muted-foreground">最小</span>
                        <span class="font-medium">{{ Math.round(task.min) }} ms</span>
                      </template>
                      <template v-if="task.max !== undefined">
                        <span class="text-muted-foreground">最大</span>
                        <span class="font-medium">{{ Math.round(task.max) }} ms</span>
                      </template>
                      <template v-if="task.avg !== undefined">
                        <span class="text-muted-foreground">平均</span>
                        <span class="font-medium">{{ Math.round(task.avg) }} ms</span>
                      </template>
                      <template v-if="task.latest !== undefined">
                        <span class="text-muted-foreground">最新</span>
                        <span class="font-medium">{{ Math.round(task.latest) }} ms</span>
                      </template>
                      <template v-if="task.p50 !== undefined">
                        <span class="text-muted-foreground">P50</span>
                        <span class="font-medium">{{ Math.round(task.p50) }} ms</span>
                      </template>
                      <template v-if="task.p99 !== undefined">
                        <span class="text-muted-foreground">P99</span>
                        <span class="font-medium">{{ Math.round(task.p99) }} ms</span>
                      </template>
                      <template v-if="task.p99_p50_ratio !== undefined">
                        <span class="text-muted-foreground">波动率</span>
                        <span class="font-medium">{{ task.p99_p50_ratio.toFixed(2) }}</span>
                      </template>
                      <template v-if="task.interval !== undefined">
                        <span class="text-muted-foreground">间隔</span>
                        <span class="font-medium">{{ task.interval }}s</span>
                      </template>
                      <template v-if="task.type">
                        <span class="text-muted-foreground">类型</span>
                        <span class="font-medium">{{ task.type.toUpperCase() }}</span>
                      </template>
                      <template v-if="task.total !== undefined">
                        <span class="text-muted-foreground">总数</span>
                        <span class="font-medium">{{ task.total }}</span>
                      </template>
                    </div>
                  </template>
                </DataTooltip>
              </div>
              <div class="text-xs mt-1 flex gap-1.5 items-center text-muted-foreground">
                <span class="font-medium" title="平均延迟">
                  {{ task.avg !== undefined ? `${Math.round(task.avg)}ms` : '-' }}
                </span>
                <template v-if="task.loss !== undefined">
                  <span class="opacity-60">·</span>
                  <span title="丢包率">{{ task.loss.toFixed(2) }}%</span>
                </template>
                <template v-if="task.p99_p50_ratio !== undefined">
                  <span class="opacity-60">·</span>
                  <span title="波动率">{{ task.p99_p50_ratio.toFixed(2) }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2 items-center py-2">
          <label class="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm bg-background/60 px-2 text-xs">
            <input :checked="showDelay" :disabled="showDelay && !showLoss" type="checkbox" class="accent-emerald-600" @change="setDelay">
            延迟
          </label>
          <label class="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm bg-background/60 px-2 text-xs">
            <input v-model="showLoss" :disabled="showLoss && !showDelay" type="checkbox" class="accent-emerald-600">
            丢包
          </label>
          <div class="flex gap-2 items-center">
            <label class="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm bg-background/60 px-2 text-xs">
              <input :checked="cutPeak" type="checkbox" class="accent-emerald-600" @change="setSmoothing">
              平滑峰值
            </label>
            <DataTooltip
              content="使用 EWMA 算法平滑数据并过滤突变值"
              placement="top"
              :content-class="pickSurfaceClass('whitespace-nowrap text-[11px]', 'whitespace-nowrap text-[11px] backdrop-blur-xl')"
            >
              <Button variant="ghost" size="icon-xs" class="text-slate-500">
                <Icon icon="carbon:information" :width="14" :height="14" />
              </Button>
            </DataTooltip>
          </div>
        </div>

        <!-- 图表 -->
        <Empty v-if="!selectedTaskIds.length" description="未选择探测线路" />
        <div
          v-else
          class="h-80 rounded-md p-4 transition-all"
          :class="pickSurfaceClass('bg-background/60 hover:bg-background', 'bg-background/50 hover:bg-background backdrop-blur-xl')"
        >
          <VChart :option="pingChartOption" :update-options="{ replaceMerge: ['series'] }" autoresize />
        </div>
      </template>
    </Spinner>
  </div>
</template>
