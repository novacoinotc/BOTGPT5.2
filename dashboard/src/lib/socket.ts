import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

class SocketService {
  private socket: Socket | null = null;
  private listeners: Map<string, Set<Function>> = new Map();
  private connectionListeners: Set<(connected: boolean) => void> = new Set();

  connect(): void {
    if (this.socket?.connected) return;

    this.socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Connected to', API_URL);
      this.notifyConnectionChange(true);
    });

    this.socket.on('disconnect', () => {
      console.log('[Socket] Disconnected');
      this.notifyConnectionChange(false);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error.message);
      this.notifyConnectionChange(false);
    });

    // Forward all events to registered listeners
    const events = [
      'status',
      'botStatus',
      'analysis',
      'positionOpened',
      'positionClosed',
      'positionUpdate',
      'kline',
      'paperTrade',
      'error',
    ];

    events.forEach(event => {
      this.socket!.on(event, (data: any) => {
        const listeners = this.listeners.get(event);
        if (listeners) {
          listeners.forEach(callback => callback(data));
        }
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  on(event: string, callback: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: Function): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionListeners.add(callback);
    // Immediately notify with current state
    callback(this.isConnected());
  }

  offConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionListeners.delete(callback);
  }

  private notifyConnectionChange(connected: boolean): void {
    this.connectionListeners.forEach(callback => callback(connected));
  }
}

export const socketService = new SocketService();
