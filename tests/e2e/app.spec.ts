import { test, expect } from '@playwright/test'

// Real browser coverage of the T31 shell (docs/ui-design.md §2): header, responsive
// panel/drawer switching at the 900px breakpoint, the drawer's focus trap and focus-return
// (R-K3), and the primary action's constant visibility (R-A1). Replaces T05's placeholder test,
// which only asserted T04's throwaway "icompress scaffold OK" text.

const DESKTOP_VIEWPORT = { width: 1280, height: 800 }
const MOBILE_VIEWPORT = { width: 600, height: 800 }

test('boots the app and shows the wordmark and primary action', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('Compressor')).toBeVisible()
  await expect(page.getByRole('button', { name: /compress/i })).toBeVisible()
})

test('desktop (>=900px): static side panel, no Options button', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/')

  await expect(page.locator('.side-panel-static')).toBeVisible()
  await expect(page.getByTestId('options-button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /compress/i })).toBeVisible()
})

test('mobile (<900px): Options opens the drawer, Compress stays visible outside it', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')

  await expect(page.locator('.side-panel-static')).toHaveCount(0)
  const optionsButton = page.getByTestId('options-button')
  await expect(optionsButton).toBeVisible()
  await expect(page.getByRole('button', { name: /compress/i })).toBeVisible()

  await optionsButton.click()
  await expect(page.getByTestId('drawer-panel')).toBeVisible()
  await expect(page.getByTestId('drawer-scrim')).toBeVisible()
  // The primary action lives outside the drawer's transform context (docs/ui-design.md §2) —
  // opening the drawer must never cover or remove it.
  await expect(page.getByRole('button', { name: /compress/i })).toBeVisible()
})

test('mobile: Escape closes the drawer and returns focus to the Options button', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')

  const optionsButton = page.getByTestId('options-button')
  await optionsButton.click()
  await expect(page.getByTestId('drawer-panel')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('drawer-panel')).toHaveCount(0)
  await expect(optionsButton).toBeFocused()
})

test('mobile: clicking the scrim closes the drawer and returns focus to Options', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')

  const optionsButton = page.getByTestId('options-button')
  await optionsButton.click()
  await page.getByTestId('drawer-scrim').click({ position: { x: 5, y: 5 } })

  await expect(page.getByTestId('drawer-panel')).toHaveCount(0)
  await expect(optionsButton).toBeFocused()
})

test('mobile: the Hide button closes the drawer and returns focus to Options', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')

  const optionsButton = page.getByTestId('options-button')
  await optionsButton.click()
  await page.getByRole('button', { name: /hide/i }).click()

  await expect(page.getByTestId('drawer-panel')).toHaveCount(0)
  await expect(optionsButton).toBeFocused()
})

test('mobile: Tab cycling stays inside the open drawer', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')

  await page.getByTestId('options-button').click()
  const hideButton = page.getByRole('button', { name: /hide/i })
  await expect(hideButton).toBeFocused()

  // The Hide button is currently the drawer's only focusable element — its three settings
  // sections have no interactive controls until T35 — so Tab must wrap straight back to it
  // rather than escaping the trap onto page content behind the scrim.
  await page.keyboard.press('Tab')
  await expect(hideButton).toBeFocused()
})
