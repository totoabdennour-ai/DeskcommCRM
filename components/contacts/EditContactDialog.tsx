"use client";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { contactPatchSchema, type ContactPatch } from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Conta } from "@/lib/schemas/contas";
import type { Contact } from "@/lib/types/contacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { apiClient } from "@/lib/api/client";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  tagsRaw?: string;
  custom_fields?: Record<string, unknown>;
}

interface Props {
  contact: Contact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Definições vindas de `crm_pipelines.settings.fields[]`. Vazio = a seção some. */
  customFieldDefs?: CustomFieldDef[];
}

export function EditContactDialog({ contact, open, onOpenChange, customFieldDefs = [] }: Props) {
  const t = useT();
  const update = useUpdateContact(contact.id);
  const [serverError, setServerError] = useState<string | null>(null);
  // Conta B2B (0239): a lista só entra no diálogo quando ele abre — a tela de
  // contatos não precisa dela até o operador editar alguém.
  const [contas, setContas] = useState<Conta[]>([]);
  const [contaSelecionada, setContaSelecionada] = useState<string | null>(contact.account_id ?? null);

  useEffect(() => {
    if (!open) return;
    let ativo = true;
    // O reset do vínculo NÃO roda no corpo síncrono do effect (regra
    // react-hooks/set-state-in-effect): viaja na mesma microtask do fetch.
    const carregar = async () => {
      setContaSelecionada(contact.account_id ?? null);
      try {
        const lista = await apiClient.get<Conta[]>("/api/v1/accounts");
        if (ativo) setContas(lista ?? []);
      } catch {
        // Sem contas (ou erro), o select fica vazio — o vínculo segue pelo
        // estado atual, nunca zera o vínculo existente por uma falha de rede.
        if (ativo) setContas([]);
      }
    };
    void carregar();
    return () => {
      ativo = false;
    };
  }, [open, contact]);

  const form = useForm<FormShape>({
    defaultValues: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
      tagsRaw: contact.tags.join(", "),
      custom_fields: contact.custom_fields ?? {},
    },
  });

  const customFields = useWatch({ control: form.control, name: "custom_fields" });

  useEffect(() => {
    if (open) {
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ? phoneForDisplay(contact.phone_number) : "",
        tagsRaw: contact.tags.join(", "),
        custom_fields: contact.custom_fields ?? {},
      });
    }
  }, [open, contact, form]);

  async function onSubmit(values: FormShape) {
    setServerError(null);
    const tags = (values.tagsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: Record<string, unknown> = {};
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    payload.tags = tags;
    // Sempre no payload, mesmo vazio: o PATCH SUBSTITUI, e é assim que apagar um
    // campo pela tela chega ao banco.
    payload.custom_fields = values.custom_fields ?? {};
    // O vínculo de conta só entra quando MUDOU — enviar `null` indevidamente
    // desvincularia o contato por causa de uma lista que falhou a carregar.
    const contaAtual = contact.account_id ?? null;
    if ((contaSelecionada ?? null) !== contaAtual) {
      payload.account_id = contaSelecionada;
    }

    const parsed = contactPatchSchema.safeParse(payload);
    if (!parsed.success) {
      setServerError(parsed.error.issues[0]?.message ?? t("Dados inválidos"));
      return;
    }
    try {
      await update.mutateAsync(parsed.data as ContactPatch);
      toast.success(t("Contato atualizado"));
      onOpenChange(false);
    } catch {
      // hook handles toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Editar contato")}</DialogTitle>
          <DialogDescription>{t("Atualize os dados deste contato.")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-name">{t("Nome")}</Label>
            <Input id="ec-name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-email">Email</Label>
            <Input id="ec-email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone">{t("Telefone (E.164)")}</Label>
            <Input id="ec-phone" {...form.register("phone_number")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-tags">Tags</Label>
            <Input id="ec-tags" {...form.register("tagsRaw")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-conta">
              {t("Conta B2B")} <span className="text-muted-foreground">{t("(opcional)")}</span>
            </Label>
            <select
              id="ec-conta"
              value={contaSelecionada ?? ""}
              onChange={(e) => setContaSelecionada(e.target.value === "" ? null : e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              data-testid="contato-conta"
            >
              <option value="">{t("Sem conta (pessoa avulsa)")}</option>
              {contas
                .filter((c) => c.status === "active" || c.id === (contact.account_id ?? ""))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t("A empresa deste contato no atendimento B2B — quem assina o pedido e recebe as condições.")}
            </p>
          </div>
          {customFieldDefs.length > 0 && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <h3 className="text-sm font-medium">{t("Campos personalizados")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("Campos definidos no funil padrão da organização.")}
                </p>
              </div>
              <CustomFieldsEditor
                fields={customFieldDefs}
                mode="contact"
                value={customFields ?? {}}
                onChange={(next) => form.setValue("custom_fields", next, { shouldDirty: true })}
              />
            </div>
          )}
          {serverError && <p className="text-sm text-error-fg">{serverError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
