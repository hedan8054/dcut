import { useCallback, useState } from 'react'
import { Upload, FileSpreadsheet, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  onUpload: (file: File) => Promise<void>
  uploading: boolean
}

export function XlsxDropZone({ onUpload, uploading }: Props) {
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file?.name.endsWith('.xlsx')) {
        await onUpload(file)
      }
    },
    [onUpload],
  )

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        await onUpload(file)
        e.target.value = ''
      }
    },
    [onUpload],
  )

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        'border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer',
        dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50',
        uploading && 'pointer-events-none opacity-60',
      )}
      onClick={() => {
        if (!uploading) document.getElementById('xlsx-input')?.click()
      }}
    >
      <input
        id="xlsx-input"
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={handleFileChange}
      />
      {uploading ? (
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-10 h-10 text-muted-foreground animate-spin" />
          <p className="text-muted-foreground">正在解析...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {dragOver ? (
            <FileSpreadsheet className="w-10 h-10 text-primary" />
          ) : (
            <Upload className="w-10 h-10 text-muted-foreground" />
          )}
          <p className="text-muted-foreground">
            拖拽 .xlsx 文件到此处，或点击选择文件
          </p>
        </div>
      )}
    </div>
  )
}
