import { PieChart, Pie, Sector, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { PieSectorShapeProps } from 'recharts'
import { formatLabel } from '../utils'
import { DECISION_COLOR_HEX, FALLBACK_COLOR_HEX } from '../constants'

interface DecisionPieChartProps {
  data: ReadonlyArray<{ decision: string; count: number }>
  height?: number
}

function renderSector(props: PieSectorShapeProps) {
  const decision = (props as PieSectorShapeProps & { decision?: string }).decision ?? ''
  return <Sector {...props} fill={DECISION_COLOR_HEX[decision] ?? FALLBACK_COLOR_HEX} />
}

export function DecisionPieChart({ data, height = 260 }: DecisionPieChartProps) {
  const chartData = data.map((d) => ({
    name: formatLabel(d.decision),
    value: d.count,
    decision: d.decision,
    fill: DECISION_COLOR_HEX[d.decision] ?? FALLBACK_COLOR_HEX,
  }))

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="45%"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
          shape={renderSector}
        />
        <Tooltip
          formatter={(value) => [String(value), 'Actions']}
          contentStyle={{
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid #e5e7eb',
          }}
        />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12 }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}
