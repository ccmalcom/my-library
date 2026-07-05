# MyLibrary UI — how to build with these components

MyLibrary is a dark, literary, book-taste app. These are its real React primitives
(`window.MyLibraryUI.*`). Build on-brand by using the token utility classes below — do
not invent your own colors, and never hardcode hex values.

## Setup & wrapping

- **No theme provider is required.** The brand tokens live on `:root` in the shipped
  stylesheet, and the palette is dark by default. Just render the components.
- **The one exception is toasts:** `useToast()` throws unless it is called inside a
  `<ToastProvider>`. Wrap the subtree (usually the whole app) in `<ToastProvider>`, then
  call `const toast = useToast()` and `toast.success(...)` / `toast.error(...)` /
  `toast.info(...)`. `Modal`, forms, everything else need no wrapper.
- **Per-user accent (optional):** the app tints UI with a per-user color via the CSS var
  `--user-accent`, surfaced as `text-user` / `bg-user` / `border-user`. Set
  `style={{ '--user-accent': '<hsl>' }}` on a wrapper to theme a subtree; it defaults to
  the brand persimmon.

## Styling idiom — Tailwind utilities with MyLibrary tokens

Style your own layout/glue with these token classes (real utilities, in the shipped CSS).
Never use raw Tailwind palette classes (`bg-gray-800`, `text-red-500`) — use the tokens:

| Purpose | Classes |
|---|---|
| Surfaces | `bg-base` (app bg), `bg-surface` (cards), `bg-elevated` (raised), `border-border` |
| Text | `text-text` (primary), `text-muted` (secondary), `text-faint` (tertiary) |
| Brand accent | `text-accent` / `bg-accent` / `bg-accent-hover` / `bg-accent-quiet` |
| Per-user accent | `text-user` / `bg-user` / `border-user` |
| Semantic | `text-success` `bg-success-quiet`, `text-danger` `bg-danger-quiet`, `text-warning` `bg-warning-quiet` |
| Fonts | `font-display` (headings — Bricolage Grotesque), `font-sans` (body — Inter), `font-mono` (data/labels — JetBrains Mono) |

The components themselves already carry these classes; you rarely restyle them — reach for
their props first (`variant`, `size`, `elevated`, `readOnly`, …).

## Where the truth lives

- **Styles:** the shipped `styles.css` (it `@import`s the compiled token stylesheet). Read
  it before styling to see every token.
- **Per-component API + usage:** each component's `.d.ts` (its `<Name>Props`) and
  `.prompt.md` under `components/general/<Name>/`.

## Idiomatic snippet

```tsx
import { Card, Badge, StarRating, Button } from 'mylibrary-frontend';

function BookRow() {
  return (
    <Card elevated className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-display text-text">Piranesi</p>
        <p className="text-sm text-muted">Susanna Clarke · 2020</p>
        <div className="mt-1 flex items-center gap-2">
          <StarRating value={5} readOnly />
          <Badge variant="success">Loved</Badge>
        </div>
      </div>
      <Button variant="ghost" size="sm">Find similar</Button>
    </Card>
  );
}
```
