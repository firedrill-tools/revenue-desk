import { LockIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useSession } from "@/app/session";
import { ListEditor } from "@/components/app/list-editor";
import { useNotify } from "@/components/app/notices";
import { ErrorState, Page, PageHeader, Panel } from "@/components/app/page";
import { SegmentedControl } from "@/components/app/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { usePolicies, useSettings } from "@/hooks/use-api";
import { ApiError, api, errorMessage } from "@/lib/api";
import {
  ACTION_CLASSES,
  type ActionClass,
  APPROVAL_MODES,
  type ApprovalMode,
  EFFORT_LEVELS,
  type PolicyView,
  type SettingsUpdate,
  type WorkspaceSettings,
} from "@/lib/contracts";
import {
  ACTION_CLASS_DESCRIPTIONS,
  ACTION_CLASS_LABELS,
  APPROVAL_MODE_LABELS,
  isHighRiskClass,
} from "@/lib/labels";
import {
  draftFromSettings,
  type FieldErrors,
  isEmptyPatch,
  normalizeChannel,
  normalizeDomain,
  policiesPatch,
  type SettingsDraft,
  settingsPatch,
  validateDraft,
} from "@/lib/settings-form";

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Panel>
      <div className="border-b px-5 py-4">
        <h2 className="font-semibold text-body">{title}</h2>
        <p className="mt-0.5 text-body-sm text-muted-foreground">{description}</p>
      </div>
      <div className="px-5 py-5">{children}</div>
      {footer ? (
        <div className="flex items-center justify-between gap-3 border-t bg-surface-subtle px-5 py-2.5">
          <p className="text-body-sm text-muted-foreground">Unsaved changes</p>
          <div className="flex items-center gap-2">{footer}</div>
        </div>
      ) : null}
    </Panel>
  );
}

function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[180px_1fr] sm:gap-6">
      <div className="pt-1.5">
        <label htmlFor={htmlFor} className="font-medium text-body-sm">
          {label}
        </label>
        {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0 space-y-1.5">
        {children}
        {error ? <p className="text-meta text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/** Discard and Save; rendered only while a section has unsaved changes. */
function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  invalid = false,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  invalid?: boolean;
}) {
  if (!dirty) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button size="sm" onClick={onSave} disabled={saving || invalid}>
        {saving ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
        Save changes
      </Button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Workspace settings (profile, Slack, email domains)
// ---------------------------------------------------------------------------

type SectionKey = "profile" | "slack" | "email";

const SECTION_FIELDS: Record<SectionKey, readonly (keyof SettingsDraft)[]> = {
  profile: [
    "companyName",
    "agentName",
    "senderName",
    "emailSignature",
    "timezone",
    "currency",
    "defaultModel",
    "defaultEffort",
  ],
  slack: ["notifySlackChannel", "allowedSlackChannels"],
  email: ["internalEmailDomains"],
};

function pickPatch(patch: SettingsUpdate, keys: readonly (keyof SettingsDraft)[]): SettingsUpdate {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => (keys as readonly string[]).includes(key)),
  ) as SettingsUpdate;
}

function pickErrors(errors: FieldErrors, keys: readonly (keyof SettingsDraft)[]): FieldErrors {
  return Object.fromEntries(
    Object.entries(errors).filter(([key]) => (keys as readonly string[]).includes(key)),
  ) as FieldErrors;
}

function useSettingsForm(
  original: WorkspaceSettings,
  onSaved: (settings: WorkspaceSettings) => void,
) {
  const notify = useNotify();
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(original));
  const [saving, setSaving] = useState<SectionKey | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const errors = { ...validateDraft(draft), ...serverErrors };
  const patch = settingsPatch(original, draft);

  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setServerErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const section = (key: SectionKey) => {
    const fields = SECTION_FIELDS[key];
    const sectionPatch = pickPatch(patch, fields);
    const sectionErrors = pickErrors(errors, fields);
    return {
      dirty: !isEmptyPatch(sectionPatch),
      invalid: !isEmptyPatch(sectionErrors),
      saving: saving === key,
      discard: () => {
        const fresh = draftFromSettings(original);
        setDraft((current) => {
          const next = { ...current };
          for (const field of fields) Object.assign(next, { [field]: fresh[field] });
          return next;
        });
      },
      save: async () => {
        setSaving(key);
        try {
          const { settings } = await api.request("PATCH /api/settings", { body: sectionPatch });
          onSaved(settings);
          const fresh = draftFromSettings(settings);
          setDraft((current) => {
            const next = { ...current };
            for (const field of fields) Object.assign(next, { [field]: fresh[field] });
            return next;
          });
          notify({ tone: "success", message: "Settings saved. They apply to the next run." });
        } catch (error) {
          if (error instanceof ApiError && error.issues.length > 0) {
            const fieldErrors: FieldErrors = {};
            for (const issue of error.issues) {
              const field = issue.path.split(".")[0] as keyof SettingsDraft;
              fieldErrors[field] = issue.message;
            }
            setServerErrors(fieldErrors);
          }
          notify({ tone: "danger", message: errorMessage(error, "Settings were not saved.") });
        } finally {
          setSaving(null);
        }
      },
    };
  };

  return { draft, errors, update, section };
}

function ProfileSection({
  form,
  envModel,
  envEffort,
}: {
  form: ReturnType<typeof useSettingsForm>;
  envModel: string;
  envEffort: string;
}) {
  const id = useId();
  const state = form.section("profile");
  const { draft, errors, update } = form;
  return (
    <Section
      title="Workspace"
      description="How the agent introduces itself, signs email and reads dates and money."
      footer={
        state.dirty ? (
          <SaveBar
            dirty={state.dirty}
            saving={state.saving}
            invalid={state.invalid}
            onSave={() => void state.save()}
            onDiscard={state.discard}
          />
        ) : null
      }
    >
      <div className="space-y-5">
        <Field label="Company name" htmlFor={`${id}-company`} error={errors.companyName}>
          <Input
            id={`${id}-company`}
            value={draft.companyName}
            onChange={(event) => update("companyName", event.target.value)}
            placeholder="Your company"
            className="max-w-md"
          />
        </Field>
        <Field
          label="Agent name"
          hint="Used in replies and notes."
          htmlFor={`${id}-agent`}
          error={errors.agentName}
        >
          <Input
            id={`${id}-agent`}
            value={draft.agentName}
            onChange={(event) => update("agentName", event.target.value)}
            className="max-w-md"
          />
        </Field>
        <Field label="Sender name" hint="The name on drafted email." htmlFor={`${id}-sender`}>
          <Input
            id={`${id}-sender`}
            value={draft.senderName}
            onChange={(event) => update("senderName", event.target.value)}
            className="max-w-md"
          />
        </Field>
        <Field label="Email signature" htmlFor={`${id}-signature`}>
          <Textarea
            id={`${id}-signature`}
            value={draft.emailSignature}
            onChange={(event) => update("emailSignature", event.target.value)}
            className="min-h-20 max-w-md"
          />
        </Field>
        <Field
          label="Time zone"
          hint="For business dates and aging."
          htmlFor={`${id}-tz`}
          error={errors.timezone}
        >
          <Input
            id={`${id}-tz`}
            value={draft.timezone}
            onChange={(event) => update("timezone", event.target.value)}
            placeholder="America/New_York"
            className="max-w-md font-mono md:text-body-sm"
          />
        </Field>
        <Field label="Currency" htmlFor={`${id}-currency`} error={errors.currency}>
          <Input
            id={`${id}-currency`}
            value={draft.currency}
            maxLength={3}
            onChange={(event) => update("currency", event.target.value.toUpperCase())}
            placeholder="USD"
            className="w-24 font-mono uppercase md:text-body-sm"
          />
        </Field>
        <Field
          label="Model"
          hint="Leave empty to use the server's AGENT_MODEL."
          htmlFor={`${id}-model`}
        >
          <Input
            id={`${id}-model`}
            value={draft.defaultModel}
            onChange={(event) => update("defaultModel", event.target.value)}
            placeholder={envModel}
            className="max-w-md font-mono md:text-body-sm"
          />
        </Field>
        <Field label="Effort" htmlFor={`${id}-effort`} error={errors.defaultEffort}>
          <Select
            value={draft.defaultEffort === "" ? "environment" : draft.defaultEffort}
            onValueChange={(value) => update("defaultEffort", value === "environment" ? "" : value)}
          >
            <SelectTrigger id={`${id}-effort`} className="h-8 w-56 text-body-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="environment">Server default ({envEffort})</SelectItem>
              {EFFORT_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </Section>
  );
}

function SlackSection({ form }: { form: ReturnType<typeof useSettingsForm> }) {
  const id = useId();
  const state = form.section("slack");
  const { draft, errors, update } = form;
  return (
    <Section
      title="Slack"
      description="Posting to an allowlisted channel is an internal write; any other channel asks first."
      footer={
        state.dirty ? (
          <SaveBar
            dirty={state.dirty}
            saving={state.saving}
            invalid={state.invalid}
            onSave={() => void state.save()}
            onDiscard={state.discard}
          />
        ) : null
      }
    >
      <div className="space-y-5">
        <Field
          label="Notices channel"
          hint="Where the agent posts refunds, handoffs and digests."
          htmlFor={`${id}-notify`}
          error={errors.notifySlackChannel}
        >
          <Input
            id={`${id}-notify`}
            value={draft.notifySlackChannel}
            onChange={(event) => update("notifySlackChannel", event.target.value)}
            placeholder="#billing"
            className="max-w-md font-mono md:text-body-sm"
          />
        </Field>
        <Field label="Allowed channels" htmlFor={`${id}-allowed`}>
          <ListEditor
            label="Allowed Slack channels"
            values={draft.allowedSlackChannels}
            onChange={(values) => update("allowedSlackChannels", values)}
            normalize={normalizeChannel}
            placeholder="Add a channel, e.g. #sales-ops"
            emptyText="No channels yet: every Slack post asks for approval."
          />
        </Field>
      </div>
    </Section>
  );
}

function EmailSection({ form }: { form: ReturnType<typeof useSettingsForm> }) {
  const id = useId();
  const state = form.section("email");
  const { draft, update } = form;
  return (
    <Section
      title="Internal email domains"
      description="Recipients and calendar attendees outside these domains are external, so the action asks first."
      footer={
        state.dirty ? (
          <SaveBar
            dirty={state.dirty}
            saving={state.saving}
            invalid={state.invalid}
            onSave={() => void state.save()}
            onDiscard={state.discard}
          />
        ) : null
      }
    >
      <Field label="Domains" htmlFor={`${id}-domains`}>
        <ListEditor
          label="Internal email domains"
          values={draft.internalEmailDomains}
          onChange={(values) => update("internalEmailDomains", values)}
          normalize={normalizeDomain}
          placeholder="Add a domain, e.g. example.com"
          emptyText="No internal domains: every recipient counts as external."
        />
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

const MODE_OPTIONS = APPROVAL_MODES.map((mode) => ({
  value: mode,
  label: APPROVAL_MODE_LABELS[mode],
}));

function PolicySection({
  policies,
  onSaved,
}: {
  policies: readonly PolicyView[];
  onSaved: (policies: readonly PolicyView[]) => void;
}) {
  const notify = useNotify();
  const initial = () =>
    Object.fromEntries(policies.map((policy) => [policy.actionClass, policy.mode])) as Record<
      ActionClass,
      ApprovalMode
    >;
  const [draft, setDraft] = useState<Record<ActionClass, ApprovalMode>>(initial);
  const [saving, setSaving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the draft when the saved policies change.
  useEffect(() => setDraft(initial()), [policies]);
  const patch = policiesPatch(policies, draft);
  const dirty = !isEmptyPatch(patch.modes);

  const save = async () => {
    setSaving(true);
    try {
      const { policies: saved } = await api.request("PATCH /api/policies", { body: patch });
      onSaved(saved);
      notify({ tone: "success", message: "Approval policy saved. It applies to the next run." });
    } catch (error) {
      notify({ tone: "danger", message: errorMessage(error, "The policy was not saved.") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Approval policy"
      description="What happens when the agent wants to act. Auto runs it, Ask waits for your approval, Deny refuses."
      footer={
        dirty ? (
          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={() => void save()}
            onDiscard={() => setDraft(initial())}
          />
        ) : null
      }
    >
      <ul className="-my-3 divide-y">
        {ACTION_CLASSES.map((actionClass) => {
          const policy = policies.find((item) => item.actionClass === actionClass);
          if (!policy) return null;
          const risky = isHighRiskClass(actionClass) || actionClass === "outbound";
          return (
            <li
              key={actionClass}
              className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium text-body-sm">{ACTION_CLASS_LABELS[actionClass]}</p>
                <p className="text-body-sm text-muted-foreground">
                  {ACTION_CLASS_DESCRIPTIONS[actionClass]}
                </p>
                {policy.locked ? (
                  <p className="mt-1 inline-flex items-center gap-1 text-meta text-muted-foreground">
                    <LockIcon className="size-3" />
                    Set by AGENT_POLICY on the server
                  </p>
                ) : null}
              </div>
              <SegmentedControl
                label={`${ACTION_CLASS_LABELS[actionClass]} actions`}
                value={draft[actionClass]}
                options={MODE_OPTIONS}
                disabled={policy.locked || saving}
                onChange={(mode) => setDraft((current) => ({ ...current, [actionClass]: mode }))}
                toneFor={(mode) => (risky && mode === "auto" ? "danger" : "default")}
              />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function SettingsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      {[0, 1].map((panel) => (
        <div key={panel} className="space-y-4 rounded-xl border p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-2/3" />
          {["a", "b", "c"].map((key) => (
            <div key={key} className="flex gap-6 pt-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-72" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SettingsForms({
  settings,
  policies,
  onSettings,
  onPolicies,
}: {
  settings: WorkspaceSettings;
  policies: readonly PolicyView[];
  onSettings: (settings: WorkspaceSettings) => void;
  onPolicies: (policies: readonly PolicyView[]) => void;
}) {
  const session = useSession();
  const form = useSettingsForm(settings, onSettings);
  return (
    <div className="space-y-6">
      <ProfileSection
        form={form}
        envModel={session?.model ?? "AGENT_MODEL"}
        envEffort={session?.effort ?? "medium"}
      />
      <PolicySection policies={policies} onSaved={onPolicies} />
      <SlackSection form={form} />
      <EmailSection form={form} />
    </div>
  );
}

export default function SettingsRoute() {
  const settings = useSettings();
  const policies = usePolicies();
  const loading = settings.loading || policies.loading;
  const error = settings.error ?? policies.error;

  return (
    <Page width="narrow">
      <PageHeader
        title="Settings"
        description="Workspace profile and approval policy. Changes apply to the next run."
      />
      {loading ? <SettingsSkeleton /> : null}
      {error ? (
        <ErrorState
          message={errorMessage(error, "Settings did not load.")}
          onRetry={() => {
            settings.reload();
            policies.reload();
          }}
        />
      ) : null}
      {settings.data && policies.data ? (
        <SettingsForms
          settings={settings.data}
          policies={policies.data}
          onSettings={(saved) => settings.mutate(saved)}
          onPolicies={(saved) => policies.mutate(saved)}
        />
      ) : null}
    </Page>
  );
}
