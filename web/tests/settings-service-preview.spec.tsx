import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ServicePreviewPanel } from '@/components/settings/ServicePreviewPanel'
import { VoiceDiscoveryField } from '@/components/settings/VoiceDiscoveryField'
import type { Catalog } from '@/lib/model-catalog-types'
const mock = vi.hoisted(() => ({ draft: {} as Catalog, fetch: vi.fn() }))
vi.mock('@/features/settings/store/SettingsStore', () => ({ useSettings: () => ({ draft: mock.draft }) }))
vi.mock('@/shared/api/client', () => ({
  asJsonOrThrow: async (response: Response) => {
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body?.detail) detail = String(body.detail);
      } catch { /* keep status line */ }
      throw new Error(detail);
    }
    return response.json();
  }, apiUrl: (s: string) => s, apiFetch: (...args: unknown[]) => mock.fetch(...args) }))
const profile = { id: 'p', name: 'Provider', binding: 'minimax', api_version: '', api_key: 'secret', base_url: 'https://example.test', models: [{ id: 'm', name: 'Model', model: 'test-model', voice: 'saved' }] }
function stream(events: object[]) {
  return { ok: true, body: new ReadableStream({ start(c) { for (const event of events) c.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); c.close() } }) }
}
beforeEach(() => {
  mock.fetch.mockReset()
  mock.draft = { version: 1, connections: [], services: Object.fromEntries(['llm','task','embedding','search','tts','stt','imagegen','videogen'].map(s => [s, { active_profile_id: 'old', active_model_id: 'old', profiles: [structuredClone(profile)] }])) } as unknown as Catalog
  URL.createObjectURL = vi.fn(() => 'blob:result')
  URL.revokeObjectURL = vi.fn()
})

it('loads live voices, preserves a saved ID and refreshes from the provider', async () => {
  mock.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'ready', scope: 'account', voices: [{ id: 'live', label: 'Live voice' }] }) })
  const update = vi.fn()
  render(<VoiceDiscoveryField profileId="p" modelId="m" value="saved" update={update} disabled={false} />)
  await screen.findByRole('option', { name: 'Live voice' })
  expect(update).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Choose a voice'), { target: { value: 'live' } })
  expect(update).toHaveBeenCalledWith('live')
  fireEvent.click(screen.getByText('Refresh'))
  await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2))
  await screen.findByRole('option', { name: 'Live voice' })
})

it('ignores late voice results after switching models and retains manual entry', async () => {
  let resolve!: (v: unknown) => void
  mock.fetch.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const update = vi.fn()
  const { rerender } = render(<VoiceDiscoveryField profileId="p" modelId="m" value="saved" update={update} disabled={false} />)
  await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1))
  const signal = mock.fetch.mock.calls[0][1].signal
  mock.draft = structuredClone(mock.draft)
  mock.draft.services.tts.profiles[0].models[0].model = 'other'
  mock.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'unsupported', voices: [], scope: 'none' }) })
  rerender(<VoiceDiscoveryField profileId="p" modelId="m" value="saved" update={update} disabled={false} />)
  await screen.findByText('This provider/model has no supported live voice lookup with this connection. You can enter a voice ID from your provider; no built-in voice list is used.')
  expect(signal.aborted).toBe(true)
  await act(async () => resolve({ ok: true, json: async () => ({ status: 'ready', voices: [{ id: 'stale', label: 'Stale voice' }], scope: 'account' }) }))
  expect(screen.queryByRole('option', { name: 'Stale voice' })).toBeNull()
  fireEvent.click(screen.getByText('Enter a voice ID manually'))
  fireEvent.change(screen.getByLabelText('Voice ID'), { target: { value: 'manual-voice' } })
  expect(update).toHaveBeenCalledWith('manual-voice')
})

it('distinguishes voice failure from an empty live list and allows retry', async () => {
  mock.fetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', voices: [], scope: 'account' }) })
  render(<VoiceDiscoveryField profileId="p" modelId="m" value="" update={vi.fn()} disabled={false} />)
  await screen.findByText('Could not fetch voices. Check the provider connection and permissions, then retry.')
  fireEvent.click(screen.getByText('Refresh'))
  await screen.findByText('The provider returned no available voices for this selection.')
})

it('searches the addressed draft and renders safe result links without applying', async () => {
  mock.fetch.mockResolvedValue(stream([{ type: 'result', kind: 'search', text: '', results: [{ title: 'Result', url: 'https://example.org', snippet: 'Found' }, { title: 'Unsafe', url: 'javascript:alert(1)', snippet: '' }] }]))
  render(<ServicePreviewPanel service="search" profile={profile} />)
  fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'a real question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await screen.findByRole('link', { name: 'Result' })
  expect(screen.queryByRole('link', { name: 'Unsafe' })).toBeNull()
  const sent = JSON.parse(mock.fetch.mock.calls[0][1].body)
  expect(sent.profile_id).toBe('p')
  expect(sent.text).toBe('a real question')
  expect(sent.catalog.services.search.active_profile_id).toBe('old')
})

it('shows completed image output and releases it on parameter change', async () => {
  mock.fetch.mockResolvedValue(stream([{ type: 'result', kind: 'image', data: btoa('image'), content_type: 'image/png' }]))
  const { rerender } = render(<ServicePreviewPanel service="imagegen" profile={profile} model={profile.models[0]} />)
  fireEvent.change(screen.getByLabelText('Describe what to generate'), { target: { value: 'test image' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }))
  await screen.findByRole('img', { name: 'test image' })
  mock.draft = structuredClone(mock.draft)
  mock.draft.services.imagegen.profiles[0].models[0].model = 'other'
  rerender(<ServicePreviewPanel service="imagegen" profile={profile} model={profile.models[0]} />)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:result')
  expect(screen.queryByRole('img')).toBeNull()
})

it('video submission remains running until media is returned and can be cancelled', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>
  mock.fetch.mockResolvedValue({ ok: true, body: new ReadableStream({ start(c) { source = c } }) })
  const { unmount } = render(<ServicePreviewPanel service="videogen" profile={profile} model={profile.models[0]} />)
  fireEvent.change(screen.getByLabelText('Describe what to generate'), { target: { value: 'a wave' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))
  await act(async () => { source.enqueue(new TextEncoder().encode('{"type":"progress","phase":"rendering"}\n')) })
  expect(screen.getByText('Task submitted. Waiting for the generated video…')).toBeTruthy()
  expect(screen.queryByText('Result received. Review it below before applying your settings.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(screen.getByText('Test stopped.')).toBeTruthy()
  await act(async () => source.close())
  unmount()
})

it('uploads real audio and displays its transcript', async () => {
  mock.fetch.mockResolvedValue(stream([{ type: 'result', kind: 'transcript', text: 'Hello from the recording' }]))
  render(<ServicePreviewPanel service="stt" profile={profile} model={profile.models[0]} />)
  fireEvent.change(screen.getByLabelText('Audio sample · WAV, MP3, M4A, WebM, OGG or FLAC · up to 8 MB'), { target: { files: [new File(['spoken audio'], 'speech.wav', { type: 'audio/wav' })] } })
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe sample' }))
  await screen.findByText('Hello from the recording')
  expect(JSON.parse(mock.fetch.mock.calls[0][1].body).audio).toBe(btoa('spoken audio'))
})
