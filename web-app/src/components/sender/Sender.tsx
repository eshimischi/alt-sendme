import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { DragDrop } from './DragDrop'
import { ShareActionCard } from './ShareActionCard'
import { SharingActiveCard } from './SharingActiveCard'
import { PulseAnimation } from './PulseAnimation'
import { TransferResultScreen } from '../TransferResultScreen'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { useSender } from '../../hooks/useSender'
import { useTranslation } from '../../i18n/react-i18next-compat'
import { SenderStatus } from '../../types/sender'

interface SenderProps {
  onTransferStateChange: (isSharing: boolean) => void
}

export function Sender({ onTransferStateChange }: SenderProps) {
  const {
    senderStatus,
    ticket,
    selectedPath,
    pathType,
    isLoading,
    copySuccess,
    alertDialog,
    transferMetadata,
    transferProgress,
    handleFileSelect,
    startSharing,
    stopSharing,
    copyTicket,
    closeAlert,
    resetForNewTransfer
  } = useSender()

  const { t } = useTranslation()

  useEffect(() => {
    // Consider any state beyond IDLE/FILE_SELECTED as "sharing"
    const isSharing = senderStatus !== SenderStatus.IDLE && senderStatus !== SenderStatus.FILE_SELECTED
    onTransferStateChange(isSharing)
  }, [senderStatus, onTransferStateChange])

  const renderContent = () => {
    console.log('[Sender Render] Current state:', senderStatus, 'Has metadata:', !!transferMetadata, 'Has progress:', !!transferProgress)
    
    switch (senderStatus) {
      case SenderStatus.IDLE:
      case SenderStatus.FILE_SELECTED:
        return (
          <>
            <div className="text-center">
              <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--app-main-view-fg)' }}>
                {t('common:sender.title')}
              </h2>
              <p className="text-sm" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                {t('common:sender.subtitle')}
              </p>
            </div>
            <div className="space-y-4 flex-1 flex flex-col">
              <DragDrop 
                onFileSelect={handleFileSelect} 
                selectedPath={selectedPath}
                isLoading={isLoading}
              />
              <ShareActionCard
                selectedPath={selectedPath}
                isLoading={isLoading}
                onFileSelect={handleFileSelect}
                onStartSharing={startSharing}
              />
            </div>
          </>
        )

      case SenderStatus.WAITING_FOR_RECEIVER:
      case SenderStatus.TRANSFERRING:
        return (
          <>
            <div className="text-center">
              <PulseAnimation 
                isTransporting={senderStatus === SenderStatus.TRANSFERRING}
                isCompleted={false}
                className="mx-auto my-4 flex items-center justify-center" 
              />
            </div>
            <div className="flex-1 flex flex-col">
              <SharingActiveCard
                isSharing={true}
                isLoading={isLoading}
                isTransporting={senderStatus === SenderStatus.TRANSFERRING}
                isCompleted={false}
                selectedPath={selectedPath}
                pathType={pathType}
                ticket={ticket}
                copySuccess={copySuccess}
                transferProgress={transferProgress}
                onStartSharing={startSharing}
                onStopSharing={stopSharing}
                onCopyTicket={copyTicket}
              />
            </div>
          </>
        )

      case SenderStatus.TRANSFER_COMPLETE:
        // Only render when metadata is available to prevent null errors
        if (!transferMetadata) return null
        
        return (
          <div className="flex-1 flex flex-col">
            <TransferResultScreen 
              metadata={transferMetadata}
              onDone={resetForNewTransfer}
            />
          </div>
        )

      case SenderStatus.TRANSFER_STOPPED:
        return (
          <div className="flex-1 flex flex-col items-center justify-center space-y-4">
            <Loader2 className="h-12 w-12 animate-spin" style={{ color: 'var(--app-accent-light)' }} />
            <p className="text-sm" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
              {t('common:sender.stoppingTransmission')}
            </p>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="p-6 space-y-6 relative h-[28rem] overflow-y-auto flex flex-col" style={{ color: 'var(--app-main-view-fg)' }}>
      {renderContent()}

      <AlertDialog open={alertDialog.isOpen} onOpenChange={closeAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{alertDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {alertDialog.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={closeAlert}>
              {t('common:ok')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
