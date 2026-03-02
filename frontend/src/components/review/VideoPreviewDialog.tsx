import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  videoUrl: string
  title?: string
}

export function VideoPreviewDialog({ open, onOpenChange, videoUrl, title = '视频预览' }: Props) {
  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = videoUrl
    a.download = videoUrl.split('/').pop() || 'clip.mp4'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <video
            src={videoUrl}
            controls
            autoPlay
            className="w-full max-h-[70vh] rounded aspect-[9/16] bg-black object-contain"
          />
          <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
            <Download className="w-3 h-3" />
            下载
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
