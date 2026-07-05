import { type ReactNode } from 'react';
interface ModalProps {
  labelId: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}
export declare function Modal({
  labelId,
  onClose,
  children,
  className,
}: ModalProps): import('react').JSX.Element;
export {};
