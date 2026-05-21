import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

interface TopToolsChartProps {
  data: ReadonlyArray<{ tool_name: string; count: number }>
  height?: number
}

/** Estimate Y-axis width from the longest tool name (monospace-ish at ~7px/char). */
function estimateLabelWidth(data: ReadonlyArray<{ tool_name: string }>): number {
  const longest = data.reduce((max, d) => Math.max(max, d.tool_name.length), 0)
  return Math.min(longest * 7.5 + 12, 220)
}

export function TopToolsChart({ data, height }: TopToolsChartProps) {
  const chartHeight = height ?? Math.max(120, data.length * 36 + 20)
  const labelWidth = useMemo(() => estimateLabelWidth(data), [data])

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        data={data as Array<{ tool_name: string; count: number }>}
        layout="vertical"
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
      >
        <XAxis
          type="number"
          allowDecimals={false}
          tick={{ fontSize: 12, fill: '#6b7280' }}
          axisLine={{ stroke: '#e5e7eb' }}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="tool_name"
          width={labelWidth}
          tick={{ fontSize: 12, fill: '#374151' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          cursor={false}
          formatter={(value) => [String(value), 'Calls']}
          contentStyle={{
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid #e5e7eb',
          }}
        />
        <Bar dataKey="count" fill="#6366f1" barSize={20} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
