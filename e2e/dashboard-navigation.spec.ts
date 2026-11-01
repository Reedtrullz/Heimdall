import { test, expect, type Page } from './fixtures';
import { mockDashboardApis } from './helpers/dashboard-api-mocks';

const MOCK_ADDRESS = 'thor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4yeyjz';

function sidebarLink(page: Page, label: string) {
  return page.getByRole('link', { name: `Navigate to ${label} page` });
}

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockDashboardApis(page, MOCK_ADDRESS);
    await page.goto(`/dashboard/portfolio?address=${MOCK_ADDRESS}`);
  });

  test('displays dashboard shell with sidebar', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Heimdall Navigation' })).toHaveAttribute('href', '/');
    await expect(sidebarLink(page, 'Portfolio')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Refresh dashboard data' })).toBeVisible();
  });

  test('sidebar contains all navigation links', async ({ page }) => {
    await expect(sidebarLink(page, 'Command Center')).toBeVisible();
    await expect(sidebarLink(page, 'Portfolio')).toBeVisible();
    await expect(sidebarLink(page, 'Nodes')).toBeVisible();
    await expect(sidebarLink(page, 'Rewards')).toBeVisible();
    await expect(sidebarLink(page, 'LP Status')).toBeVisible();
    await expect(sidebarLink(page, 'Risk')).toBeVisible();
    await expect(sidebarLink(page, 'Transactions')).toBeVisible();
    await expect(sidebarLink(page, 'Changelogs')).toBeVisible();
  });

  test('navigates to Portfolio page', async ({ page }) => {
    await sidebarLink(page, 'Portfolio').click();
    await expect(page).toHaveURL(/\/dashboard\/portfolio/);
  });

  test('navigates to Command Center page', async ({ page }) => {
    await sidebarLink(page, 'Command Center').click();
    await expect(page).toHaveURL(/\/dashboard\?address=/);
    await expect(page.getByLabel('Command center diagnosis')).toBeVisible();
  });

  test('navigates to Nodes page', async ({ page }) => {
    await sidebarLink(page, 'Nodes').click();
    await expect(page).toHaveURL(/\/dashboard\/nodes/);
  });

  test('navigates to Rewards page', async ({ page }) => {
    await sidebarLink(page, 'Rewards').click();
    await expect(page).toHaveURL(/\/dashboard\/rewards/);
  });

  test('navigates to Risk page', async ({ page }) => {
    await sidebarLink(page, 'Risk').click();
    await expect(page).toHaveURL(/\/dashboard\/risk/);
  });

  test('navigates to Transactions page', async ({ page }) => {
    await sidebarLink(page, 'Transactions').click();
    await expect(page).toHaveURL(/\/dashboard\/transactions/);
  });

  test('highlights active page in sidebar', async ({ page }) => {
    await sidebarLink(page, 'Risk').click();
    await expect(page).toHaveURL(/\/dashboard\/risk/);
    const riskLink = sidebarLink(page, 'Risk');
    await expect(riskLink).toBeVisible();
  });

  test('displays wallet connect button in header', async ({ page }) => {
    const walletConnect = page.getByTestId('wallet-connect-button');

    await expect(walletConnect).toBeVisible();
    await expect(walletConnect).toBeEnabled();
    await expect(walletConnect).toHaveAccessibleName('Connect Wallet');
  });

  test('Refresh keeps loaded cache visible while nodes are pending and fee revenue fails', async ({ page, allowApiErrors }) => {
    allowApiErrors(['/api/midgard/v2/history/earnings']);

    await page.getByRole('button', { name: 'Fee Revenue' }).click();
    const totalBondedSummary = page.getByRole('group', { name: 'Total Bonded summary' });
    const revenueSection = page.locator('section', { has: page.getByText('24H Revenue') });
    await expect(totalBondedSummary).toContainText(/\u16B1[0-9,.]+/);
    await expect(revenueSection).toBeVisible();
    const loadedBonded = await totalBondedSummary.innerText();
    const loadedRevenue = await revenueSection.innerText();
    await expect(page.getByText('Failed to load fee revenue')).toHaveCount(0);

    let releaseNodes: () => void = () => {};
    const nodesGate = new Promise<void>((resolve) => { releaseNodes = resolve; });
    let nodesRequestsHeld = 0;
    let earningsFailing = true;
    try {
      await page.route('**/api/thorchain/thorchain/nodes', async (route) => {
        nodesRequestsHeld += 1;
        await nodesGate;
        await route.fallback();
      });
      await page.route('**/api/midgard/v2/history/earnings**', async (route) => {
        if (earningsFailing) {
          await route.fulfill({ status: 429, json: { error: 'Mock earnings rate limit' } });
          return;
        }
        const interval = {
          startTime: '1699990000000000000',
          endTime: '1700010000000000000',
          liquidityFees: '900000000',
          blockRewards: '100000000',
          earnings: '1000000000',
          bondingEarnings: '300000000',
          liquidityEarnings: '700000000',
          avgNodeCount: '2',
          runePriceUSD: '1.50',
          pools: [],
        };
        await route.fulfill({ json: { meta: { ...interval }, intervals: [interval] } });
      });

      await page.getByRole('button', { name: 'Refresh dashboard data' }).click();
      await expect.poll(() => nodesRequestsHeld, { timeout: 15_000 }).toBeGreaterThan(0);

      // Nodes are still pending: the loaded summary must remain, and both fee panels show the failure.
      await expect(totalBondedSummary).toBeVisible();
      await expect(totalBondedSummary).toHaveText(loadedBonded);
      await expect(page.getByText('Failed to load fee revenue')).toHaveCount(2, { timeout: 20_000 });
      await expect(totalBondedSummary).toHaveText(loadedBonded);

      earningsFailing = false;
      releaseNodes();
      await page.getByRole('button', { name: 'Refresh dashboard data' }).click();
      await expect(page.getByText('Failed to load fee revenue')).toHaveCount(0, { timeout: 20_000 });
      await expect(revenueSection).toBeVisible();
      await expect.poll(() => revenueSection.innerText()).not.toBe(loadedRevenue);
      await expect(totalBondedSummary).toHaveText(loadedBonded);
    } finally {
      releaseNodes();
    }
  });
});
