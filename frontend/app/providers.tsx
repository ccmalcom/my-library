'use client';

import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateIfStale: true,
        dedupingInterval: 30_000,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}
