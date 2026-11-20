import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  PROVIDER_ICONS,
  providerIconSpec,
  formatProviderLabel,
  formatConfiguredProviderName,
} from '../lib/provider-branding'

const root = path.resolve(process.cwd(), '..')
const asset = (file: string) => path.join(root, 'web/public/provider-icons', file)

describe('provider branding', () => {
  it('covers every branded provider in all service registries', () => {
    const llm = readFileSync(path.join(root, 'reff/deeptutor/services/provider_registry.py'), 'utf8')
    const services = readFileSync(path.join(root, 'reff/deeptutor/services/config/provider_runtime.py'), 'utf8')
    const ids = new Set([
      ...Array.from(llm.matchAll(/name="([a-z_]+)"/g), m => m[1]),
      ...Array.from(services.matchAll(/^    "([a-z_]+)": \w+ProviderSpec\(/gm), m => m[1]),
    ])
    // Y-API and google-browser-scraper have no verified official brand asset;
    // retain the generic fallback. `local` is the web_fetch extraction backend
    // (FETCH_PROVIDERS), not a brandable search/LLM provider.
    const generic = new Set([
      'none', 'custom', 'custom_anthropic', 'custom_openai_sdk', 'custom_chat', 'y_api',
      'google_browser_scraper',
      'local',
    ])
    expect(ids.size).toBeGreaterThan(50)
    for (const id of ids) {
      if (generic.has(id)) expect(providerIconSpec(id), id).toBeUndefined()
      else expect(providerIconSpec(id), id).toBeDefined()
    }
  })

  it('ships every referenced asset, including dark variants, without external SVG content', () => {
    for (const spec of Object.values(PROVIDER_ICONS)) {
      for (const file of [spec.file, spec.darkFile].filter(Boolean) as string[]) {
        expect(existsSync(asset(file)), file).toBe(true)
        const content = readFileSync(asset(file))
        expect(content.length, file).toBeGreaterThan(100)
        if (file.endsWith('.svg')) {
          const svg = content.toString()
          expect(svg).toContain('<svg')
          expect(svg).not.toMatch(/<script|<foreignObject|\bon\w+=|(?:href|src)=["']https?:/i)
        }
      }
    }
  })

  it('resolves legacy aliases but leaves unknown custom brands generic', () => {
    expect(providerIconSpec(' workbuddy ')).toEqual(providerIconSpec('codebuddy'))
    expect(providerIconSpec('atlas_cloud')).toEqual(providerIconSpec('atlascloud'))
    for (const id of ['my-gateway', '__proto__', 'constructor', '', null]) {
      expect(providerIconSpec(id)).toBeUndefined()
    }
  })

  it('returns catalog labels and configured names unchanged', () => {
    // English-only UI: no locale-specific branding is added or stripped.
    expect(formatProviderLabel('deepseek', 'DeepSeek', 'en')).toBe('DeepSeek')
    expect(formatProviderLabel('deepseek', 'DeepSeek', 'zh')).toBe('DeepSeek')
    expect(formatProviderLabel('openai', 'OpenAI', 'zh-CN')).toBe('OpenAI')
    expect(formatConfiguredProviderName('moonshot', 'Moonshot', 'zh')).toBe('Moonshot')
    expect(formatConfiguredProviderName('deepseek', 'My study account', 'en')).toBe('My study account')
    expect(formatConfiguredProviderName('deepseek', 'DeepSeek（深度求索）', 'zh')).toBe('DeepSeek（深度求索）')
  })
})
