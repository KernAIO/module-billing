<script lang="ts">
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  IconButton,
  Input,
  type MenuItem,
  messageLocale,
  Select,
  Skeleton,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getBillingApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Plan } from '../index.js'
import { formatMoney } from '../index.js'

/**
 * The catalogue: what this instance sells.
 *
 * A plan is data rather than code precisely so that this screen exists — the price an instance
 * charges, what it includes, and what its marketing page shows are one row, edited here, instead of
 * a constant in a repository and a second copy on a website that drift apart.
 *
 * A limit left empty means unlimited. The set of limits is fixed by the contract: an administrator
 * decides the values, never the keys, because a key nothing enforces is a promise nobody keeps.
 */

const api = getBillingApi()
const queryClient = useQueryClient()
const locale = $derived(messageLocale())
const nf = $derived(new Intl.NumberFormat(locale))

const GB = 1024 ** 3

interface Draft {
  id?: string
  name: string
  slug: string
  description: string
  price: string
  currency: string
  interval: 'month' | 'year'
  perSeat: boolean
  trialDays: string
  seats: string
  storageGb: string
  sso: boolean
  auditDays: string
  stripePriceId: string
  order: string
  published: boolean
}

const emptyDraft = (): Draft => ({
  name: '',
  slug: '',
  description: '',
  price: '0',
  currency: 'usd',
  interval: 'month',
  perSeat: true,
  trialDays: '14',
  seats: '',
  storageGb: '',
  sso: true,
  auditDays: '',
  stripePriceId: '',
  order: '100',
  published: false,
})

const toDraft = (p: Plan): Draft => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  description: p.description,
  price: String(p.priceMinor / 100),
  currency: p.currency,
  interval: p.interval,
  perSeat: p.perSeat,
  trialDays: String(p.trialDays),
  seats: p.limits.seats === null ? '' : String(p.limits.seats),
  storageGb: p.limits.storageBytes === null ? '' : String(Math.round(p.limits.storageBytes / GB)),
  sso: p.limits.sso,
  auditDays: p.limits.auditRetentionDays === null ? '' : String(p.limits.auditRetentionDays),
  stripePriceId: p.stripePriceId ?? '',
  order: String(p.order),
  published: p.published,
})

/** An empty field means "no limit", which is not the same as zero. */
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v))

let editing = $state<Draft | null>(null)
let archiving = $state<Plan | null>(null)

const plans = createQuery(() => ({
  queryKey: ['billing', 'plan', 'all'],
  queryFn: () => api.plans.list({ includeUnpublished: true }),
}))

const refresh = () => queryClient.invalidateQueries({ queryKey: ['billing'] })

const save = createMutation(() => ({
  mutationFn: (d: Draft) =>
    api.plans.upsert({
      ...(d.id ? { id: d.id } : {}),
      slug: d.slug.trim(),
      name: d.name.trim(),
      description: d.description.trim(),
      priceMinor: Math.round(Number(d.price || 0) * 100),
      currency: d.currency.trim().toLowerCase(),
      interval: d.interval,
      perSeat: d.perSeat,
      trialDays: Number(d.trialDays || 0),
      limits: {
        seats: numOrNull(d.seats),
        storageBytes: d.storageGb.trim() === '' ? null : Number(d.storageGb) * GB,
        modules: null,
        sso: d.sso,
        auditRetentionDays: numOrNull(d.auditDays),
        apiRateLimit: null,
      },
      stripePriceId: d.stripePriceId.trim() || null,
      highlights: [],
      published: d.published,
      order: Number(d.order || 100),
    }),
  onSuccess: () => {
    toast.success(t('admin_plan_saved'))
    editing = null
    void refresh()
  },
  onError: (e: Error) => toast.error(e.message),
}))

const setPublished = createMutation(() => ({
  mutationFn: (v: { id: string; published: boolean }) => api.plans.setPublished(v),
  onSuccess: (plan) => {
    toast.success(
      plan.published
        ? t('admin_plan_published_toast', { name: plan.name })
        : t('admin_plan_unpublished_toast', { name: plan.name }),
    )
    void refresh()
  },
  onError: (e: Error) => toast.error(e.message),
}))

const archive = createMutation(() => ({
  mutationFn: (id: string) => api.plans.archive({ id }),
  onSuccess: () => {
    toast.success(t('admin_plan_archived_toast', { name: archiving?.name ?? '' }))
    archiving = null
    void refresh()
  },
  onError: (e: Error) => toast.error(e.message),
}))

function actionsFor(plan: Plan): MenuItem[] {
  return [
    { label: t('admin_plan_edit'), icon: 'pencil', onSelect: () => (editing = toDraft(plan)) },
    {
      label: plan.published ? t('admin_plan_unpublish') : t('admin_plan_publish'),
      icon: plan.published ? 'eye-off' : 'eye',
      // A plan with no Stripe price can still be published — it just cannot be bought, only
      // assigned. The form says so rather than the menu refusing.
      onSelect: () => setPublished.mutate({ id: plan.id, published: !plan.published }),
    },
    { type: 'separator' },
    {
      label: t('admin_plan_archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => (archiving = plan),
    },
  ]
}

const intervalOptions = $derived([
  { value: 'month', label: t('admin_plan_interval_month') },
  { value: 'year', label: t('admin_plan_interval_year') },
])
</script>

<svelte:head><title>{t('admin_plans_title')} · {t('common.admin')}</title></svelte:head>

<div class="grid gap-5">
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="grid gap-1">
      <h1 class="text-[20px] font-medium text-[var(--kern-ink-900)]">{t('admin_plans_title')}</h1>
      <p class="text-[13px] text-[var(--kern-ink-400)]">{t('admin_plans_subtitle')}</p>
    </div>
    <Button onclick={() => (editing = emptyDraft())}>{t('admin_plan_new')}</Button>
  </header>

  {#if plans.isPending}
    <Skeleton class="h-[200px] w-full rounded-[var(--kern-r-md)]" />
  {:else if plans.isError}
    <EmptyState title={t('admin_error')} icon="triangle-alert">
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void refresh()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if (plans.data ?? []).length === 0}
    <EmptyState title={t('admin_plans_empty')} description={t('admin_plans_empty_hint')} icon="tag">
      {#snippet actions()}
        <Button onclick={() => (editing = emptyDraft())}>{t('admin_plan_new')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="overflow-x-auto">
      <Table columns="minmax(160px,2fr) minmax(120px,1fr) minmax(110px,auto) minmax(90px,auto) minmax(110px,auto) 40px">
        <TableHeader>
          <TableCell header>{t('admin_plan_name')}</TableCell>
          <TableCell header>{t('admin_plan_price')}</TableCell>
          <TableCell header end>{t('admin_plan_seats')}</TableCell>
          <TableCell header end>{t('admin_plan_storage_gb')}</TableCell>
          <TableCell header>{t('status')}</TableCell>
          <TableCell header end></TableCell>
        </TableHeader>
        {#each plans.data ?? [] as plan (plan.id)}
          <TableRow>
            <TableCell>
              <div class="grid">
                <span class="truncate text-[13px] text-[var(--kern-ink-900)]">{plan.name}</span>
                <span class="truncate font-[var(--kern-font-mono)] text-[11px] text-[var(--kern-ink-400)]">
                  {plan.slug}
                </span>
              </div>
            </TableCell>
            <TableCell>
              {formatMoney(plan.priceMinor, plan.currency, locale)}
              <span class="text-[11px] text-[var(--kern-ink-400)]">
                {plan.interval === 'year' ? t('per_year') : t('per_month')}
              </span>
            </TableCell>
            <TableCell end>{plan.limits.seats == null ? t('unlimited') : nf.format(plan.limits.seats)}</TableCell>
            <TableCell end>
              {plan.limits.storageBytes === null
                ? t('unlimited')
                : nf.format(Math.round(plan.limits.storageBytes / GB))}
            </TableCell>
            <TableCell>
              <Badge tone={plan.published ? 'success' : 'grey'}>
                {plan.published ? t('admin_plan_published') : t('admin_plan_draft')}
              </Badge>
            </TableCell>
            <TableCell end>
              <DropdownMenu items={actionsFor(plan)} align="end">
                {#snippet trigger(props)}
                  <IconButton {...props} icon="ellipsis" size={28} label={t('actions')} />
                {/snippet}
              </DropdownMenu>
            </TableCell>
          </TableRow>
        {/each}
      </Table>
    </div>
  {/if}
</div>

<Dialog
  open={editing !== null}
  size="lg"
  title={editing?.id ? t('admin_plan_edit') : t('admin_plan_new')}
  onOpenChange={(o) => {
    if (!o) editing = null
  }}
>
  {#snippet children()}
    {#if editing}
      <div class="grid gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label={t('admin_plan_name')}>
            {#snippet children(id)}
              <Input {id} bind:value={editing!.name} />
            {/snippet}
          </Field>
          <Field label={t('admin_plan_slug')} hint={t('admin_plan_slug_hint')}>
            {#snippet children(id)}
              <Input {id} bind:value={editing!.slug} />
            {/snippet}
          </Field>
        </div>

        <Field label={t('admin_plan_description')}>
          {#snippet children(id)}
            <Textarea {id} bind:value={editing!.description} rows={2} />
          {/snippet}
        </Field>

        <div class="grid gap-4 sm:grid-cols-3">
          <Field label={t('admin_plan_price')} hint={t('admin_plan_price_hint')}>
            {#snippet children(id)}
              <Input {id} type="number" min="0" step="1" bind:value={editing!.price} />
            {/snippet}
          </Field>
          <Field label={t('admin_plan_currency')}>
            {#snippet children(id)}
              <Input {id} bind:value={editing!.currency} />
            {/snippet}
          </Field>
          <Field label={t('admin_plan_interval')}>
            {#snippet children(id)}
              <Select {id} bind:value={editing!.interval} options={intervalOptions} />
            {/snippet}
          </Field>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <Checkbox
            bind:checked={editing!.perSeat}
            label={t('admin_plan_per_seat')}
            description={t('admin_plan_per_seat_hint')}
          />
          <Field label={t('admin_plan_trial_days')}>
            {#snippet children(id)}
              <Input {id} type="number" min="0" bind:value={editing!.trialDays} />
            {/snippet}
          </Field>
        </div>

        <div class="grid gap-2">
          <span class="text-[13px] font-medium text-[var(--kern-ink-900)]">{t('admin_plan_limits')}</span>
          <span class="text-[12px] text-[var(--kern-ink-400)]">{t('admin_plan_limits_hint')}</span>
          <div class="mt-1 grid gap-4 sm:grid-cols-3">
            <Field label={t('admin_plan_seats')}>
              {#snippet children(id)}
                <Input {id} type="number" min="1" bind:value={editing!.seats} />
              {/snippet}
            </Field>
            <Field label={t('admin_plan_storage_gb')}>
              {#snippet children(id)}
                <Input {id} type="number" min="0" bind:value={editing!.storageGb} />
              {/snippet}
            </Field>
            <Field label={t('admin_plan_audit_days')}>
              {#snippet children(id)}
                <Input {id} type="number" min="1" bind:value={editing!.auditDays} />
              {/snippet}
            </Field>
          </div>
          <Checkbox bind:checked={editing!.sso} label={t('admin_plan_sso')} />
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <Field label={t('admin_plan_stripe_price')} hint={t('admin_plan_stripe_price_hint')}>
            {#snippet children(id)}
              <Input {id} bind:value={editing!.stripePriceId} placeholder="price_…" />
            {/snippet}
          </Field>
          <Field label={t('admin_plan_order')}>
            {#snippet children(id)}
              <Input {id} type="number" bind:value={editing!.order} />
            {/snippet}
          </Field>
        </div>

        <Checkbox bind:checked={editing!.published} label={t('admin_plan_published')} />
      </div>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (editing = null)}>{t('admin_cancel')}</Button>
    <Button
      loading={save.isPending}
      disabled={!editing?.name.trim() || !editing?.slug.trim()}
      onclick={() => editing && save.mutate($state.snapshot(editing))}
    >
      {t('admin_save')}
    </Button>
  {/snippet}
</Dialog>

<!-- Archiving withdraws a plan from sale; whoever is on it stays on it, and the dialog says so. -->
<Dialog
  open={archiving !== null}
  title={archiving ? t('admin_archive_title', { name: archiving.name }) : ''}
  description={t('admin_archive_body')}
  onOpenChange={(o) => {
    if (!o) archiving = null
  }}
>
  {#snippet children()}{/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archiving = null)}>{t('admin_cancel')}</Button>
    <Button variant="danger" loading={archive.isPending} onclick={() => archiving && archive.mutate(archiving.id)}>
      {t('admin_archive_confirm')}
    </Button>
  {/snippet}
</Dialog>
