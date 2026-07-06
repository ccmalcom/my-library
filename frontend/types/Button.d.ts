type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}
export declare const Button: import('react').ForwardRefExoticComponent<
  ButtonProps & import('react').RefAttributes<HTMLButtonElement>
>;
export {};
