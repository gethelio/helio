interface PageErrorProps {
  error: string
}

export function PageError({ error }: PageErrorProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-500">
      <p className="text-sm">{error}</p>
      <button
        type="button"
        onClick={() => {
          window.location.reload()
        }}
        className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
      >
        Retry
      </button>
    </div>
  )
}
