import { type ReactNode } from 'react';
interface ToastControls {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}
export declare function useToast(): ToastControls;
export declare function ToastProvider({
  children,
}: {
  children: ReactNode;
}): import('react').JSX.Element;
export {};
