interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => React.ReactNode;
}
export declare function Field({
  label,
  error,
  hint,
  required,
  children,
}: FieldProps): import('react').JSX.Element;
export {};
