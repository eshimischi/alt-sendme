import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import type { AlertDialogState, AlertType, TransferMetadata, TransferProgress, SenderStatus } from '../types/sender'
import { SenderStatus as Status } from '../types/sender'

export interface UseSenderReturn {
  senderStatus: SenderStatus
  ticket: string | null
  selectedPath: string | null
  pathType: 'file' | 'directory' | null
  isLoading: boolean
  copySuccess: boolean
  alertDialog: AlertDialogState
  transferMetadata: TransferMetadata | null
  transferProgress: TransferProgress | null
  
  handleFileSelect: (path: string) => void
  startSharing: () => Promise<void>
  stopSharing: () => Promise<void>
  copyTicket: () => Promise<void>
  showAlert: (title: string, description: string, type?: AlertType) => void
  closeAlert: () => void
  resetForNewTransfer: () => Promise<void>
}

export function useSender(): UseSenderReturn {
  const [senderStatus, setSenderStatus] = useState<SenderStatus>(Status.IDLE)
  const [ticket, setTicket] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [pathType, setPathType] = useState<'file' | 'directory' | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)
  const [transferMetadata, setTransferMetadata] = useState<TransferMetadata | null>(null)
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null)
  const [transferStartTime, setTransferStartTime] = useState<number | null>(null)
  const wasManuallyStoppedRef = useRef(false)
  const [alertDialog, setAlertDialog] = useState<AlertDialogState>({
    isOpen: false,
    title: '',
    description: '',
    type: 'info'
  })

  // Helper to log state transitions
  const transitionToState = (newState: SenderStatus, reason: string) => {
    console.log(`[Sender State] ${senderStatus} → ${newState} (${reason})`)
    setSenderStatus(newState)
  }

  // Use refs for values needed in event listeners to avoid recreating listeners
  const transferStartTimeRef = useRef<number | null>(null)
  const selectedPathRef = useRef<string | null>(null)
  const lastProgressRef = useRef<TransferProgress | null>(null) // Track last progress
  const listenersSetupRef = useRef(false) // Track if listeners are already set up
  
  // Sync refs with state
  useEffect(() => {
    transferStartTimeRef.current = transferStartTime
  }, [transferStartTime])
  
  useEffect(() => {
    selectedPathRef.current = selectedPath
  }, [selectedPath])
  
  useEffect(() => {
    lastProgressRef.current = transferProgress
  }, [transferProgress])

  useEffect(() => {
    // Prevent duplicate setup (React 18 strict mode runs effects twice)
    if (listenersSetupRef.current) {
      console.log('[Setup] Listeners already set up, skipping...')
      return
    }
    listenersSetupRef.current = true
    
    let unlistenProgress: UnlistenFn | undefined
    let unlistenComplete: UnlistenFn | undefined
    let unlistenFailed: UnlistenFn | undefined
    let progressUpdateTimeout: NodeJS.Timeout | undefined

    const setupListeners = async () => {
      console.log('[Setup] Setting up event listeners')
      
      unlistenProgress = await listen('transfer-progress', (event: any) => {
        console.log('[Progress Event] Received progress event:', event.payload)
        try {
          const payload = event.payload as string
          const parts = payload.split(':')
          
          if (parts.length === 3) {
            const bytesTransferred = parseInt(parts[0], 10)
            const totalBytes = parseInt(parts[1], 10)
            const speedInt = parseInt(parts[2], 10)
            const speedBps = speedInt / 1000.0
            const percentage = totalBytes > 0 ? (bytesTransferred / totalBytes) * 100 : 0
            
            console.log(`[Progress Event] Parsed: ${bytesTransferred}/${totalBytes} bytes (${percentage.toFixed(1)}%)`)
            
            // CRITICAL: Update ref immediately, don't wait for state update
            // This prevents race conditions with completion events
            const progressData = {
              bytesTransferred,
              totalBytes,
              speedBps,
              percentage
            }
            lastProgressRef.current = progressData
            
            // Transition from WAITING_FOR_RECEIVER to TRANSFERRING on first progress event
            setSenderStatus(prev => {
              if (prev === Status.WAITING_FOR_RECEIVER && totalBytes > 0) {
                console.log(`[Sender State] ${prev} → ${Status.TRANSFERRING} (first progress event)`)
                setTransferStartTime(Date.now())
                setTransferProgress(null)
                setTransferMetadata(null)
                wasManuallyStoppedRef.current = false
                return Status.TRANSFERRING
              }
              console.log(`[Progress Event] State is ${prev}, not transitioning`)
              return prev
            })
            
            if (progressUpdateTimeout) {
              clearTimeout(progressUpdateTimeout)
            }
            
            progressUpdateTimeout = setTimeout(() => {
              setTransferProgress(progressData)
            }, 100)
          }
        } catch (error) {
          console.error('Failed to parse progress event:', error)
        }
      })

      unlistenComplete = await listen('transfer-completed', async () => {
        console.log('[Complete Event] Transfer completed, wasManuallyStoppedRef:', wasManuallyStoppedRef.current)
        
        if (wasManuallyStoppedRef.current) {
          console.log('[Complete Event] Ignoring - was manually stopped')
          return
        }
        
        // Check current state - only accept if we're in TRANSFERRING
        let currentState: SenderStatus | null = null
        setSenderStatus(prev => {
          currentState = prev
          return prev
        })
        
        // Reject if not in TRANSFERRING state
        if (currentState !== Status.TRANSFERRING) {
          console.log(`[Complete Event] Ignoring - wrong state (current: ${currentState}, expected: TRANSFERRING)`)
          console.log('[Complete Event] This is likely a metadata/handshake completion, not actual data transfer')
          return
        }
        
        // We're in TRANSFERRING state - this is a legitimate completion
        // The backend has validated last_progress_bytes >= total_file_size
        const lastProgress = lastProgressRef.current
        if (lastProgress) {
          console.log('[Complete Event] Last progress:', lastProgress.percentage.toFixed(1) + '%', 
                      `(${lastProgress.bytesTransferred}/${lastProgress.totalBytes} bytes)`)
        }
        
        console.log('[Complete Event] Accepting completion (state=TRANSFERRING, backend validated 100%)')
        
        if (progressUpdateTimeout) {
          clearTimeout(progressUpdateTimeout)
        }
        
        setTransferProgress(null)
        
        const endTime = Date.now()
        const startTime = transferStartTimeRef.current
        const path = selectedPathRef.current
        const duration = startTime ? endTime - startTime : 0
        
        console.log('[Complete Event] Using path:', path, 'startTime:', startTime)
        
        // Always set metadata before transitioning state
        let metadata
        if (path) {
          try {
            const fileSize = await invoke<number>('get_file_size', { path })
            const fileName = path.split('/').pop() || 'Unknown'
            metadata = { 
              fileName, 
              fileSize, 
              duration, 
              startTime: startTime || endTime, 
              endTime 
            }
            console.log('[Complete Event] Metadata created:', metadata)
          } catch (error) {
            console.error('Failed to get file size:', error)
            const fileName = path.split('/').pop() || 'Unknown'
            metadata = { 
              fileName, 
              fileSize: 0, 
              duration, 
              startTime: startTime || endTime, 
              endTime 
            }
          }
        } else {
          // Fallback if path is missing
          metadata = {
            fileName: 'Unknown',
            fileSize: 0,
            duration,
            startTime: startTime || endTime,
            endTime
          }
          console.log('[Complete Event] No path, using fallback metadata')
        }
        
        // Set metadata first, then transition state
        setTransferMetadata(metadata)
        console.log('[Complete Event] Metadata set, scheduling state transition to TRANSFER_COMPLETE')
        // Use setTimeout to ensure metadata state update is processed before status change
        setTimeout(() => {
          console.log('[Sender State] → TRANSFER_COMPLETE (transfer completed)')
          setSenderStatus(Status.TRANSFER_COMPLETE)
        }, 0)
      })

      unlistenFailed = await listen('transfer-failed', async () => {
        console.log('[Failed Event] Transfer failed, wasManuallyStoppedRef:', wasManuallyStoppedRef.current)
        
        if (wasManuallyStoppedRef.current) {
          console.log('[Failed Event] Ignoring - was manually stopped')
          return
        }
        
        if (progressUpdateTimeout) {
          clearTimeout(progressUpdateTimeout)
        }
        
        setTransferProgress(null)
        
        const endTime = Date.now()
        const startTime = transferStartTimeRef.current
        const path = selectedPathRef.current
        const duration = startTime ? endTime - startTime : 0
        
        // Always set metadata before transitioning state
        const fileName = path?.split('/').pop() || 'Unknown'
        const metadata: TransferMetadata = { 
          fileName, 
          fileSize: 0, 
          duration, 
          startTime: startTime || endTime, 
          endTime,
          wasStopped: true
        }
        
        console.log('[Failed Event] Setting metadata and transitioning to TRANSFER_STOPPED')
        setTransferMetadata(metadata)
        // Transition to TRANSFER_STOPPED
        setTimeout(() => {
          console.log('[Sender State] → TRANSFER_STOPPED (transfer failed)')
          setSenderStatus(Status.TRANSFER_STOPPED)
        }, 0)
        
        // Auto-transition to IDLE after showing stopped state briefly
        setTimeout(() => {
          console.log('[Sender State] → IDLE (auto-transition after stopped)')
          setSenderStatus(Status.IDLE)
          setTransferMetadata(null)
        }, 2000)
      })
    }

    setupListeners().catch((error) => {
      console.error('Failed to set up event listeners:', error)
    })

    return () => {
      console.log('[Cleanup] Cleaning up event listeners')
      listenersSetupRef.current = false
      if (progressUpdateTimeout) {
        clearTimeout(progressUpdateTimeout)
      }
      if (unlistenProgress) unlistenProgress()
      if (unlistenComplete) unlistenComplete()
      if (unlistenFailed) unlistenFailed()
    }
  }, []) // ✅ Empty dependency array - listeners only set up once

  const showAlert = (title: string, description: string, type: AlertType = 'info') => {
    setAlertDialog({ isOpen: true, title, description, type })
  }

  const closeAlert = () => {
    setAlertDialog(prev => ({ ...prev, isOpen: false }))
  }

  const handleFileSelect = async (path: string) => {
    setSelectedPath(path)
    try {
      const type = await invoke<string>('check_path_type', { path })
      setPathType(type as 'file' | 'directory')
      // Transition from IDLE to FILE_SELECTED
      transitionToState(Status.FILE_SELECTED, 'file selected')
    } catch (error) {
      console.error('Failed to check path type:', error)
      setPathType(null)
    }
  }

  const startSharing = async () => {
    if (!selectedPath) return
    
    try {
      setIsLoading(true)
      const result = await invoke<string>('start_sharing', { path: selectedPath })
      setTicket(result)
      console.log('[Start Sharing] Ticket received:', result)
      // Transition from FILE_SELECTED to WAITING_FOR_RECEIVER
      transitionToState(Status.WAITING_FOR_RECEIVER, 'sharing started')
    } catch (error) {
      console.error('Failed to start sharing:', error)
      showAlert('Sharing Failed', `Failed to start sharing: ${error}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const stopSharing = async () => {
    try {
      const currentStatus = senderStatus
      console.log('[Stop Sharing] Current status:', currentStatus)
      
      // If in WAITING_FOR_RECEIVER, just go back to IDLE
      if (currentStatus === Status.WAITING_FOR_RECEIVER) {
        await invoke('stop_sharing')
        // Transition to IDLE and reset
        transitionToState(Status.IDLE, 'stopped while waiting')
        setTicket(null)
        setSelectedPath(null)
        setPathType(null)
        setTransferProgress(null)
        setTransferStartTime(null)
        setTransferMetadata(null)
        wasManuallyStoppedRef.current = false
        return
      }
      
      // If in TRANSFERRING, stop and show stopped state
      if (currentStatus === Status.TRANSFERRING) {
        console.log('[Stop Sharing] Stopping active transfer')
        wasManuallyStoppedRef.current = true
        
        const endTime = Date.now()
        const fileName = selectedPath?.split('/').pop() || 'Unknown'
        
        const stoppedMetadata: TransferMetadata = {
          fileName,
          fileSize: 0,
          duration: 0,
          startTime: transferStartTime || endTime,
          endTime,
          wasStopped: true
        }
        
        setTransferMetadata(stoppedMetadata)
        transitionToState(Status.TRANSFER_STOPPED, 'manually stopped during transfer')
        
        await invoke('stop_sharing')
        
        // Auto-transition to IDLE after showing stopped state briefly
        setTimeout(() => {
          console.log('[Stop Sharing] Auto-transitioning to IDLE')
          transitionToState(Status.IDLE, 'auto-transition after stop')
          setTicket(null)
          setSelectedPath(null)
          setPathType(null)
          setTransferProgress(null)
          setTransferStartTime(null)
          setTransferMetadata(null)
          wasManuallyStoppedRef.current = false
        }, 2000)
        return
      }
      
      // If in TRANSFER_COMPLETE or TRANSFER_STOPPED, reset to IDLE
      if (currentStatus === Status.TRANSFER_COMPLETE || currentStatus === Status.TRANSFER_STOPPED) {
        console.log('[Stop Sharing] Resetting from completed/stopped state')
        wasManuallyStoppedRef.current = false
        transitionToState(Status.IDLE, 'reset after complete/stopped')
        setTicket(null)
        setSelectedPath(null)
        setPathType(null)
        setTransferProgress(null)
        setTransferStartTime(null)
        setTransferMetadata(null)
        
        invoke('stop_sharing').catch((error) => {
          console.warn('Background cleanup failed (non-critical):', error)
        })
        return
      }
    } catch (error) {
      console.error('Failed to stop sharing:', error)
      showAlert('Stop Sharing Failed', `Failed to stop sharing: ${error}`, 'error')
    }
  }

  const resetForNewTransfer = async () => {
    await stopSharing()
  }

  const copyTicket = async () => {
    if (ticket) {
      try {
        await navigator.clipboard.writeText(ticket)
        setCopySuccess(true)
        setTimeout(() => setCopySuccess(false), 2000)
      } catch (error) {
        console.error('Failed to copy ticket:', error)
        showAlert('Copy Failed', `Failed to copy ticket: ${error}`, 'error')
      }
    }
  }

  return {
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
    showAlert,
    closeAlert,
    resetForNewTransfer
  }
}
