/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeedbackTab } from '@/components/admin/FeedbackTab';
import { ToastProvider } from '@/components/ui';

const listAdminFeedback = jest.fn();
const updateAdminFeedbackStatus = jest.fn();

jest.mock('@/lib/api', () => ({
  listAdminFeedback: (...args: unknown[]) => listAdminFeedback(...args),
  updateAdminFeedbackStatus: (...args: unknown[]) => updateAdminFeedbackStatus(...args),
  createFeedbackGithubIssue: jest.fn(),
}));

// Call the fetcher once per key without involving SWR's shared cache.
jest.mock('swr', () => {
  const React = jest.requireActual('react');
  function useMockSWR(key: unknown, fetcher: () => Promise<unknown>) {
    const [data, setData] = React.useState(undefined);
    React.useEffect(() => {
      let alive = true;
      fetcher().then((d: unknown) => {
        if (alive) setData(d);
      });
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(key)]);
    return { data, isLoading: data === undefined, mutate: jest.fn() };
  }
  return {
    __esModule: true,
    default: useMockSWR,
  };
});

const ITEM = {
  id: 1,
  user_id: 'u1',
  email: 'one@example.com',
  category: 'bug',
  body: 'crash on import',
  trigger: null,
  run_id: null,
  page: null,
  app_version: null,
  status: 'open',
  github_issue_number: null,
  github_issue_url: null,
  created_at: '2026-08-19T00:00:00',
};

function renderTab(overrides: Record<string, unknown> = {}) {
  listAdminFeedback.mockResolvedValue({
    items: [ITEM],
    total: 1,
    limit: 25,
    offset: 0,
    github_configured: true,
    ...overrides,
  });
  return render(
    <ToastProvider>
      <FeedbackTab />
    </ToastProvider>
  );
}

describe('FeedbackTab', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults to the open-and-active status filter', async () => {
    renderTab();
    await waitFor(() => expect(listAdminFeedback).toHaveBeenCalled());
    expect(listAdminFeedback.mock.calls[0][0]).toMatchObject({
      status: 'open,reported,in_progress',
    });
  });

  it('sends no status when the filter is set to all', async () => {
    renderTab();
    await screen.findByText('crash on import');
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: '' } });
    await waitFor(() => {
      const last = listAdminFeedback.mock.calls.at(-1)![0];
      expect(last.status).toBeUndefined();
    });
  });

  it('changes a row status through the inline select', async () => {
    updateAdminFeedbackStatus.mockResolvedValue({ ...ITEM, status: 'resolved' });
    renderTab();
    await screen.findByText('crash on import');
    fireEvent.change(screen.getByLabelText('Status for feedback 1'), {
      target: { value: 'resolved' },
    });
    await waitFor(() => expect(updateAdminFeedbackStatus).toHaveBeenCalledWith(1, 'resolved'));
  });

  it('offers issue creation only when github is configured', async () => {
    const { unmount } = renderTab();
    expect(await screen.findByRole('button', { name: /create github issue/i })).toBeInTheDocument();
    unmount();

    jest.clearAllMocks();
    renderTab({ github_configured: false });
    await screen.findByText('crash on import');
    expect(screen.queryByRole('button', { name: /create github issue/i })).toBeNull();
  });

  it('links to an existing issue instead of offering to create one', async () => {
    renderTab({
      items: [
        {
          ...ITEM,
          status: 'reported',
          github_issue_number: 12,
          github_issue_url: 'https://github.com/ccmalcom/shelfsprite/issues/12',
        },
      ],
    });
    const link = await screen.findByRole('link', { name: '#12' });
    expect(link).toHaveAttribute('href', 'https://github.com/ccmalcom/shelfsprite/issues/12');
    expect(screen.queryByRole('button', { name: /create github issue/i })).toBeNull();
  });
});
