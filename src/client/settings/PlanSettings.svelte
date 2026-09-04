<script lang="ts">
import {
  Badge,
  Button,
  Card,
  EmptyState,
  messageLocale,
  ProgressBar,
  Skeleton,
  session,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tooltip,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getBillingApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Plan } from '../index.js'
import {
  BILLING_PERMISSIONS,
  formatBytes,
  formatMoney,
  planBlockedReason,
  trialDaysLeft,
  usageRatio,
} from '../index.js'

/**
 * What this workspace is on, what it uses, and what it has been charged.
 *
 * Everything money-shaped is read from the server rather than worked out here: a second opinion
 * about somebody's bill, computed in a browser, is the one kind of disagreement this screen must not
 * be able to have.
 */

const api = getBillingApi()
const queryClient = useQueryClient()

/**
 * The shell passes these; a module page does not read the router.
 *
 * `$app/state` is a SvelteKit alias, and a package is type-checked on its own — reaching for the
 * router here fails standalone even though it resolves inside the app. `ModuleRoute` already hands
 * every module page the workspace it is rendering.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
}
const { workspaceId, workspaceSlug: slug }: Props = $props()
const canManage = $derived(session.can(BILLING_PERMISSIONS.manage))
const locale = $derived(messageLocale())

/** Where Stripe sends the person back to, and where the portal returns them. */
const returnPath = $derived(`/${slug}/settings/billing/plan`)

/**
 * What Stripe said on the way back, from `?checkout=`.
 *
 * Read from `window.location` rather than the router: a module page cannot import `$app/state` — it
 * is a SvelteKit alias, and this package is type-checked on its own. The parameter is stripped once
 * read, so a refresh half an hour later does not announce a payment again.
 *
 * Nothing used to read it at all: the person came back from paying to a page that looked exactly
 * as it had before they left, which reads as a payment that did not work.
 */
type Outcome = 'done' | 'cancelled' | 'changed'
let outcome = $state<Outcome | null>(null)
/** True between "Stripe took the card" and "the webhook told us about it". */
let awaitingWebhook = $state(false)
/** How long a webhook may take before the page stops promising it is coming. */
const WEBHOOK_GRACE_MS = 90_000
/** When waiting stops being honest. Fixed once, when the wait starts. */
let waitDeadline = $state<number | null>(null)

$effect(() => {
  const url = new URL(window.location.href)
  const value = url.searchParams.get('checkout')
  if (value !== 'done' && value !== 'cancelled' && value !== 'changed') return
  outcome = value
  awaitingWebhook = value === 'done'
  waitDeadline = value === 'done' ? Date.now() + WEBHOOK_GRACE_MS : null
  url.searchParams.delete('checkout')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
})

const billing = createQuery(() => ({
  queryKey: ['billing', 'subscription', workspaceId],
  queryFn: () => api.subscription.get({ workspaceId }),
  enabled: Boolean(workspaceId),
  // Stripe redirects the browser back before it has delivered the webhook, so the subscription is
  // genuinely not there yet for a second or two. Polling is what turns "nothing happened" into a
  // page that fills itself in.
  refetchInterval: awaitingWebhook ? 3_000 : false,
}))

const plans = createQuery(() => ({
  queryKey: ['billing', 'plan', 'offered'],
  queryFn: () => api.plans.list({ includeUnpublished: false }),
  enabled: Boolean(workspaceId),
}))

const invoices = createQuery(() => ({
  queryKey: ['billing', 'invoice', workspaceId],
  queryFn: () => api.subscription.invoices({ workspaceId, limit: 24 }),
  enabled: Boolean(workspaceId),
}))

const data = $derived(billing.data)
const sub = $derived(data?.subscription ?? null)
const usage = $derived(data?.usage ?? { seats: 0, storageBytes: 0, updatedAt: '' })

/**
 * Stop waiting — either because the webhook landed, or because it is not going to.
 *
 * A poll with no end is the failure mode here: if `STRIPE_WEBHOOK_SECRET` is wrong, every delivery
 * is rejected and the subscription never appears, so a page promising "this updates itself" refetches
 * every three seconds for as long as the tab is open and never stops lying. The deadline is fixed
 * when the wait starts rather than restarted here, because this effect re-runs on every poll — a
 * timer created inside it would be cleared and rebuilt each time and could never fire.
 */
let webhookStalled = $state(false)

$effect(() => {
  if (!awaitingWebhook) return
  /**
   * `stripeSubscriptionId` is the signal, and it has to be — a status is not one.
   *
   * A workspace that is about to pay for the first time already has a subscription *row*: signup
   * writes one on the default plan, `trialing`, with no Stripe subscription behind it. So "there is
   * a row, and it is not cancelled" is true before the customer ever reaches Stripe, and waiting on
   * it declares the payment confirmed on the first poll — which is the same lie the wait exists to
   * avoid, told faster. `applySubscription` is what fills this column in, and it only ever runs from
   * a webhook that verified.
   */
  if (sub?.stripeSubscriptionId) {
    awaitingWebhook = false
    return
  }
  const left = (waitDeadline ?? 0) - Date.now()
  if (left <= 0) {
    awaitingWebhook = false
    webhookStalled = true
    return
  }
  const timer = setTimeout(() => {
    awaitingWebhook = false
    webhookStalled = true
  }, left)
  return () => clearTimeout(timer)
})

const STATUS_LABEL: Record<string, () => string> = {
  trialing: () => t('status_trialing'),
  active: () => t('status_active'),
  past_due: () => t('status_past_due'),
  canceled: () => t('status_canceled'),
  suspended: () => t('status_suspended'),
}
const STATUS_TONE: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'grey'> = {
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  canceled: 'grey',
  suspended: 'danger',
}

const trialLeft = $derived(trialDaysLeft(sub?.trialEndsAt ?? null))

function priceNote(plan: Plan): string {
  if (plan.priceMinor === 0) return t('free')
  if (plan.interval === 'year') return plan.perSeat ? t('per_user_year') : t('per_year')
  return plan.perSeat ? t('per_user_month') : t('per_month')
}

// every number a person reads goes through Intl, counts included — a Latin seat count beside a
// Persian byte count is the one untranslated thing on the screen
const nf = $derived(new Intl.NumberFormat(locale))
const dateFmt = $derived(new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }))
const day = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—')

const reload = () => {
  void queryClient.invalidateQueries({ queryKey: ['billing'] })
}

/**
 * Buying a plan, or moving to another one.
 *
 * The server decides which of the two it is — a workspace with a subscription is repriced in place,
 * one without goes through Checkout — and says so in `changed`. A repriced plan is already live, so
 * there is nowhere to send the browser.
 */
const checkout = createMutation(() => ({
  mutationFn: (planSlug: string) => api.subscription.checkout({ workspaceId, planSlug, returnPath }),
  onSuccess: ({ url, changed }) => {
    if (changed) {
      toast.success(t('plan_changed'))
      reload()
      return
    }
    window.location.href = url
  },
  onError: (e: Error) => toast.error(e.message),
  onSettled: () => {
    leaving = false
  },
}))

const portal = createMutation(() => ({
  mutationFn: () => api.subscription.portal({ workspaceId, returnPath }),
  onSuccess: ({ url }) => {
    window.location.href = url
  },
  onError: (e: Error) => toast.error(e.message),
  onSettled: () => {
    leaving = false
  },
}))

/**
 * Guards the second click, which `disabled={mutation.isPending}` does not.
 *
 * The attribute reaches the button on the next render and two quick clicks are one render apart —
 * on this screen that opens two Stripe Checkout sessions, or files two plan changes, each of which
 * is a proration the customer sees on their bill.
 */
let leaving = $state(false)
function once(run: () => void) {
  if (leaving) return
  leaving = true
  run()
}
</script>

<svelte:head><title>{t('title')} · {t('common.settings')}</title></svelte:head>

<!-- `limit` is already formatted by the caller: bytes have to arrive as "50 GB", never as the
     number itself, and a snippet that took a number could not tell the two apart. -->
{#snippet meter(label: string, used: string, limit: string | null, ratio: number | null)}
  <div class="grid gap-1.5">
    <div class="flex items-baseline justify-between gap-3">
      <span class="text-[13px] text-[var(--kern-ink-700)]">{label}</span>
      <span class="font-[var(--kern-font-mono)] text-[12px] text-[var(--kern-ink-400)]">
        {limit === null ? used : t('usage_of', { used, limit })}
      </span>
    </div>
    {#if ratio === null}
      <div class="text-[12px] text-[var(--kern-ink-400)]">{t('unlimited')}</div>
    {:else}
      <ProgressBar value={ratio * 100} tone={ratio >= 1 ? 'danger' : ratio > 0.85 ? 'info' : 'accent'} />
    {/if}
  </div>
{/snippet}

<div class="grid gap-6">
  <header class="grid gap-1">
    <h1 class="text-[20px] font-medium text-[var(--kern-ink-900)]">{t('title')}</h1>
    <p class="text-[13px] text-[var(--kern-ink-400)]">{t('subtitle')}</p>
  </header>

  <!-- What happened at Stripe. Coming back from a payment to a page that looks exactly as it did
       before you left reads as a payment that failed, so the page says which of the three it was —
       including the honest middle one, where the money has moved and the webhook has not landed. -->
  {#if outcome}
    {@const pending = outcome === 'done' && awaitingWebhook}
    {@const stalled = outcome === 'done' && webhookStalled}
    {@const tone =
      outcome === 'cancelled'
        ? 'var(--kern-slate-tint)'
        : stalled
          ? 'var(--kern-warning-tint)'
          : pending
            ? 'var(--kern-info-tint)'
            : 'var(--kern-success-tint)'}
    <div
      class="flex items-start justify-between gap-3 rounded-[var(--kern-r-sm)] px-3 py-2.5"
      style="background: {tone}"
      role="status"
    >
      <div class="grid gap-0.5">
        <span class="text-[13px] font-medium text-[var(--kern-ink-900)]">
          {outcome === 'cancelled'
            ? t('checkout_cancelled')
            : outcome === 'changed'
              ? t('checkout_changed')
              : stalled
                ? t('checkout_slow')
                : pending
                  ? t('checkout_pending')
                  : sub?.status === 'trialing'
                    ? t('checkout_trial')
                    : t('checkout_done')}
        </span>
        <span class="text-[13px] text-[var(--kern-ink-700)]">
          {outcome === 'cancelled'
            ? t('checkout_cancelled_hint')
            : outcome === 'changed'
              ? t('plan_changed')
              : stalled
                ? t('checkout_slow_hint')
                : pending
                  ? t('checkout_pending_hint')
                  : sub?.status === 'trialing'
                    ? t('checkout_trial_hint')
                    : t('checkout_done_hint')}
        </span>
      </div>
      <Button variant="ghost" size="sm" onclick={() => (outcome = null)}>{t('dismiss')}</Button>
    </div>
  {/if}

  {#if billing.isPending}
    <Skeleton class="h-[132px] w-full rounded-[var(--kern-r-md)]" />
    <Skeleton class="h-[180px] w-full rounded-[var(--kern-r-md)]" />
  {:else if billing.isError}
    <EmptyState title={t('error')} icon="triangle-alert">
      {#snippet actions()}
        <Button variant="secondary" onclick={reload}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <!-- current plan -->
    <!-- The card's own padding is off so the 20px inside is the only padding, on every side. -->
    <Card padding="none">
      <div class="grid gap-4 p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="grid gap-1">
            <span class="text-[12px] text-[var(--kern-ink-400)]">{t('current_plan')}</span>
            <div class="flex items-center gap-2">
              <span class="text-[17px] font-medium text-[var(--kern-ink-900)]">
                {sub?.planName ?? t('no_plan')}
              </span>
              {#if sub}
                <Badge tone={STATUS_TONE[sub.status] ?? 'grey'}>
                  {(STATUS_LABEL[sub.status] ?? (() => t('status_active')))()}
                </Badge>
              {/if}
            </div>
            {#if !sub}
              <p class="text-[13px] text-[var(--kern-ink-400)]">{t('no_plan_hint')}</p>
            {:else if sub.status === 'trialing' && trialLeft !== null}
              <p class="text-[13px] text-[var(--kern-ink-400)]">
                {trialLeft === 0 ? t('trial_ends_today') : t('trial_days_left', { count: trialLeft })}
              </p>
            {:else if sub.currentPeriodEnd}
              <p class="text-[13px] text-[var(--kern-ink-400)]">
                {sub.cancelAtPeriodEnd ? t('cancels') : t('renews')}
                {day(sub.currentPeriodEnd)}
              </p>
            {/if}
          </div>

          {#if data?.paymentsEnabled && sub?.stripeCustomerId}
            <!-- disabled controls say why: a dead button with no explanation is a bug -->
            <Tooltip text={t('no_permission')} disabled={canManage}>
              {#snippet children(props)}
                <span {...props}>
                  <Button
                    variant="secondary"
                    disabled={!canManage || portal.isPending}
                    loading={portal.isPending}
                    onclick={() => once(() => portal.mutate())}
                  >
                    {t('manage_payment')}
                  </Button>
                </span>
              {/snippet}
            </Tooltip>
          {/if}
        </div>

        {#if sub?.status === 'past_due'}
          <p class="rounded-[var(--kern-r-sm)] bg-[var(--kern-warning-tint)] px-3 py-2 text-[13px] text-[var(--kern-ink-900)]">
            {t('past_due_hint')}
          </p>
        {:else if sub?.status === 'suspended'}
          <p class="rounded-[var(--kern-r-sm)] bg-[var(--kern-danger-tint)] px-3 py-2 text-[13px] text-[var(--kern-ink-900)]">
            {t('suspended_hint')}
          </p>
        {/if}

        <div class="grid gap-4 sm:grid-cols-2">
          {@render meter(
            t('seats'),
            nf.format(usage.seats),
            data?.limits.seats == null ? null : nf.format(data.limits.seats),
            usageRatio(usage.seats, data?.limits.seats ?? null),
          )}
          {@render meter(
            t('storage'),
            formatBytes(usage.storageBytes, locale),
            data?.limits.storageBytes == null ? null : formatBytes(data.limits.storageBytes, locale),
            usageRatio(usage.storageBytes, data?.limits.storageBytes ?? null),
          )}
        </div>
      </div>
    </Card>

    <!-- what can be bought -->
    {#if !data?.paymentsEnabled}
      <p class="text-[13px] text-[var(--kern-ink-400)]">{t('payments_disabled')}</p>
    {:else if plans.isPending}
      <Skeleton class="h-[160px] w-full rounded-[var(--kern-r-md)]" />
    {:else if (plans.data ?? []).length === 0}
      <EmptyState title={t('no_plans')} description={t('no_plans_hint')} icon="tag" />
    {:else}
      <!-- `grid-auto-rows:1fr` + `display:grid` on the cell, so a longer description does not leave
           the card beside it visibly short -->
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" style="grid-auto-rows: 1fr">
        {#each plans.data ?? [] as plan (plan.id)}
          {@const isCurrent = sub?.planId === plan.id}
          {@const blocked = planBlockedReason(plan, { seats: usage.seats })}
          <li class="grid">
            <!--
              `Card` is a block: a `grid` class on it does not reach its content, so the gap
              between the highlights and the button was lost and the button sat flush against the
              last line with the card's padding pooled underneath. The layout lives on an element
              of our own inside the card.
            -->
            <Card padding="none">
              <div class="grid h-full content-between gap-5 p-5">
              <div class="grid gap-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[15px] font-medium text-[var(--kern-ink-900)]">{plan.name}</span>
                  {#if isCurrent}<Badge tone="accent">{t('current')}</Badge>{/if}
                </div>
                <div class="flex items-baseline gap-1.5">
                  <!-- 22px type at the default line-height leaves a hole above the digits. -->
                  <span class="text-[22px] font-medium leading-none text-[var(--kern-ink-900)]">
                    {formatMoney(plan.priceMinor, plan.currency, locale)}
                  </span>
                  <span class="text-[12px] text-[var(--kern-ink-400)]">{priceNote(plan)}</span>
                </div>
                <!--
                  Free text an administrator typed, in whatever language they typed it. Under a
                  Persian screen an English highlight rendered backwards — "2 GB of storage" with
                  the 2 at the far end — because the block's direction was applied to a line whose
                  own direction is Latin. `dir="auto"` on the block fixed the order and broke the
                  alignment — the line became a left-aligned island in a right-aligned card — and
                  so did `unicode-bidi: plaintext`, because Chrome resolves `text-align: start`
                  against the paragraph's resolved direction in both cases. `<bdi>` isolates the
                  run inside a block that keeps the card's direction and alignment.
                -->
                {#if plan.description}
                  <p class="text-[13px] text-[var(--kern-ink-700)]"><bdi>{plan.description}</bdi></p>
                {/if}
                {#if plan.highlights.length}
                  <ul class="mt-1 grid gap-1">
                    {#each plan.highlights as h (h)}
                      <li class="text-[12.5px] text-[var(--kern-ink-700)]"><bdi>{h}</bdi></li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <!-- A plan smaller than the workspace names the number it cannot fit, rather than
                   refusing on submit with nothing to act on. -->
              <Tooltip
                text={blocked === 'seats'
                  ? t('blocked_seats', {
                      seats: nf.format(plan.limits.seats ?? 0),
                      used: nf.format(usage.seats),
                    })
                  : t('no_permission')}
                disabled={blocked === null && canManage}
              >
                {#snippet children(props)}
                  <span class="block w-full" {...props}>
                    <Button
                      class="w-full"
                      variant={isCurrent ? 'secondary' : 'primary'}
                      disabled={isCurrent || !canManage || blocked !== null || checkout.isPending}
                      loading={checkout.isPending && checkout.variables === plan.slug}
                      onclick={() => once(() => checkout.mutate(plan.slug))}
                    >
                      {isCurrent ? t('current') : t('choose_plan')}
                    </Button>
                  </span>
                {/snippet}
              </Tooltip>
              </div>
            </Card>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- invoices -->
    <section class="grid gap-2">
      <h2 class="text-[14px] font-medium text-[var(--kern-ink-900)]">{t('invoices_section')}</h2>
      {#if invoices.isPending}
        <Skeleton class="h-[96px] w-full rounded-[var(--kern-r-md)]" />
      {:else if (invoices.data?.items ?? []).length === 0}
        <EmptyState
          title={t('invoices_empty')}
          description={t('invoices_empty_hint')}
          icon="file-text"
          compact
        />
      {:else}
        <div class="overflow-x-auto">
          <Table columns="minmax(120px,1fr) minmax(120px,1fr) minmax(100px,auto) minmax(80px,auto)">
            <TableHeader>
              <TableCell header>{t('invoice_number')}</TableCell>
              <TableCell header>{t('invoice_date')}</TableCell>
              <TableCell header end>{t('invoice_amount')}</TableCell>
              <TableCell header end></TableCell>
            </TableHeader>
            {#each invoices.data?.items ?? [] as inv (inv.id)}
              <TableRow>
                <TableCell>{inv.number ?? '—'}</TableCell>
                <TableCell>{day(inv.createdAt)}</TableCell>
                <TableCell end>{formatMoney(inv.totalMinor, inv.currency, locale)}</TableCell>
                <TableCell end>
                  <!-- Both links Stripe gives us: the hosted page (pay, see the receipt) and the PDF
                       an accountant files. Neither is ours to render, so nothing is shown when
                       Stripe sent none. -->
                  <span class="inline-flex items-center gap-3">
                    {#if inv.hostedUrl}
                      <a
                        class="text-[13px] text-[var(--kern-accent-deep)] underline-offset-2 hover:underline"
                        href={inv.hostedUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {t('invoice_view')}
                      </a>
                    {/if}
                    {#if inv.pdfUrl}
                      <a
                        class="text-[13px] text-[var(--kern-accent-deep)] underline-offset-2 hover:underline"
                        href={inv.pdfUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {t('invoice_pdf')}
                      </a>
                    {/if}
                  </span>
                </TableCell>
              </TableRow>
            {/each}
          </Table>
        </div>
      {/if}
    </section>
  {/if}
</div>