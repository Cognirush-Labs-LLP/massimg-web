import { test, expect } from '@playwright/test'

// Real browser coverage of the T31 shell (docs/ui-design.md §2): header, responsive
// panel/drawer switching at the 900px breakpoint, the drawer's focus trap and focus-return
// (R-K3), and the primary action's constant visibility (R-A1). Replaces T05's placeholder test,
// which only asserted T04's throwaway "icompress scaffold OK" text.

// tests/e2e has no DOM lib (tsconfig.node.json), so the page-side reads below are declared
// minimally — the same convention as tests/e2e/i18n-rtl.spec.ts and credits.spec.ts.
declare interface DomRect {
  top: number
  left: number
  bottom: number
  height: number
}
declare interface DomElement {
  getBoundingClientRect: () => DomRect
  contains: (other: DomElement | null) => boolean
}
declare const document: {
  querySelector: (selector: string) => DomElement | null
  elementFromPoint: (x: number, y: number) => DomElement | null
}
declare function getComputedStyle(element: DomElement): {
  position: string
  paddingBottom: string
  paddingTop: string
}

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

// The mobile action bar is an ordinary flex item at the end of .tool-page, not an overlay
// (T43 changed it from `position: fixed`). These two tests pin that, because the difference is
// invisible until it is wrong in one of two opposite ways: an overlay with no clearance hides
// the bottom of the stage, and clearance with no overlay wastes a bar's height of stage — which
// is what happened, costing Preview about 17% of its frame on a phone until it was removed.
test('mobile (<900px): the action bar takes its own space rather than covering the stage', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()

  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.mobile-action-bar')
    const body = document.querySelector('.stage-body')
    if (bar === null || body === null) return null
    return {
      position: getComputedStyle(bar).position,
      barTop: bar.getBoundingClientRect().top,
      bodyBottom: body.getBoundingClientRect().bottom,
      bodyPaddingBottom: parseFloat(getComputedStyle(body).paddingBottom),
      bodyPaddingTop: parseFloat(getComputedStyle(body).paddingTop),
    }
  })

  expect(geometry).not.toBeNull()
  // In flow, so it cannot cover anything.
  expect(geometry!.position).toBe('static')
  // The stage ends where the bar begins: adjacent, not overlapping.
  expect(Math.round(geometry!.bodyBottom)).toBeLessThanOrEqual(Math.round(geometry!.barTop) + 1)
  // And the stage reserves no extra room for it — symmetric padding, nothing set aside.
  expect(geometry!.bodyPaddingBottom).toBe(geometry!.bodyPaddingTop)
})

test('mobile (<900px): the open drawer reaches its last control without reserving a bar height', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/')
  await page.getByTestId('options-button').click()
  await expect(page.getByTestId('drawer-panel')).toBeVisible()

  const geometry = await page.evaluate(() => {
    const scroll = document.querySelector('.drawer-scroll')
    const bar = document.querySelector('.mobile-action-bar')
    if (scroll === null || bar === null) return null
    const barBox = bar.getBoundingClientRect()
    // The drawer panel is fixed and full-height, so with the bar no longer positioned the
    // drawer paints over it. Hit-test inside the drawer's own column, at the bar's height.
    const topmost = document.elementFromPoint(
      Math.round(scroll.getBoundingClientRect().left) + 10,
      Math.round(barBox.top) + Math.round(barBox.height / 2),
    )
    return {
      paddingBottom: parseFloat(getComputedStyle(scroll).paddingBottom),
      drawerIsOnTop: topmost !== null && scroll.contains(topmost),
    }
  })

  expect(geometry).not.toBeNull()
  expect(geometry!.drawerIsOnTop).toBe(true)
  // Breathing room under the last control, not a reserved bar height.
  expect(geometry!.paddingBottom).toBeLessThan(40)
})
