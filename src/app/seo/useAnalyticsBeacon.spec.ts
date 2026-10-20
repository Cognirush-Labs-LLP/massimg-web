import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useHead = vi.fn()
vi.mock('@unhead/vue', () => ({ useHead: (input: unknown) => useHead(input) }))

const { useAnalyticsBeacon } = await import('./useAnalyticsBeacon')
const { beaconScriptSrc, cfBeaconToken } = await import('@/config/analytics')

beforeEach(() => {
  useHead.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// The R-V2 half that tests/e2e/ cannot reach: the beacon only fires in a production build, so
// what it carries is asserted here rather than over the wire. tests/e2e-pwa/pwa.spec.ts already
// proves the real request fires against a real `pnpm build`; this proves its payload is nothing
// but the site token — no file name, no dimensions, no sizes, no identifier of any kind.
describe('useAnalyticsBeacon (R-V2, R-V3)', () => {
  it('declares exactly one beacon script, carrying only the site token', () => {
    vi.stubEnv('PROD', true)
    useAnalyticsBeacon()

    expect(useHead).toHaveBeenCalledOnce()
    const scripts = (useHead.mock.calls[0]?.[0] as { script: Record<string, unknown>[] }).script
    expect(scripts).toHaveLength(1)

    const entry = scripts[0]!
    expect(Object.keys(entry).sort()).toEqual(['data-cf-beacon', 'defer', 'src'])
    expect(entry['src']).toBe(beaconScriptSrc)
    expect(JSON.parse(entry['data-cf-beacon'] as string)).toEqual({ token: cfBeaconToken })
  })

  it('declares nothing at all outside a production build', () => {
    vi.stubEnv('PROD', false)
    useAnalyticsBeacon()

    expect(useHead).not.toHaveBeenCalled()
  })
})
