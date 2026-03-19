import { useRef, useCallback, useEffect } from 'react';

interface ReconnectingWSOptions {
  url: string;
  onMessage: (event: MessageEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

/**
 * WebSocket hook with automatic reconnection and exponential backoff.
 * Returns connect/disconnect/send functions.
 */
export function useReconnectingWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef<ReconnectingWSOptions | null>(null);
  const intentionalCloseRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback((options: ReconnectingWSOptions) => {
    optionsRef.current = options;
    intentionalCloseRef.current = false;

    const {
      url,
      onMessage,
      onOpen,
      onClose,
      maxRetries = 10,
      baseDelay = 1000,
      maxDelay = 30000,
    } = options;

    // Clean up any existing connection
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      retriesRef.current = 0; // Reset retries on successful connect
      onOpen?.();
    };

    ws.onmessage = onMessage;

    ws.onerror = () => {
      // Error handler — reconnect is handled by onclose
    };

    ws.onclose = () => {
      wsRef.current = null;
      onClose?.();

      // Don't reconnect if intentionally closed
      if (intentionalCloseRef.current) return;

      // Don't reconnect if we've exhausted retries
      if (retriesRef.current >= maxRetries) {
        console.warn(`[WS] Max reconnection attempts (${maxRetries}) reached`);
        return;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, retriesRef.current), maxDelay);
      const jitter = delay * 0.2 * Math.random();
      retriesRef.current++;

      console.log(`[WS] Reconnecting in ${Math.round(delay + jitter)}ms (attempt ${retriesRef.current}/${maxRetries})`);
      timerRef.current = setTimeout(() => {
        if (optionsRef.current) {
          connect(optionsRef.current);
        }
      }, delay + jitter);
    };

    return ws;
  }, []);

  const disconnect = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const send = useCallback((data: string | object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  return {
    connect,
    disconnect,
    send,
    getSocket: () => wsRef.current,
  };
}
