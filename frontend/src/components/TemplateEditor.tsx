import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CalendarDays, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';

export type TemplateSectionFormat = 'paragraph' | 'list' | 'string';

export interface TemplateSectionForm {
  title: string;
  instruction: string;
  format: TemplateSectionFormat;
  item_format?: string;
}

export interface TemplateForm {
  name: string;
  description: string;
  sections: TemplateSectionForm[];
}

const EMPTY_SECTION: TemplateSectionForm = {
  title: '',
  instruction: '',
  format: 'paragraph',
};

const DATE_SECTION: TemplateSectionForm = {
  title: 'Fecha',
  instruction:
    'Usa la fecha real de la reunión indicada en las instrucciones del sistema. No inventes ni infieras una fecha distinta.',
  format: 'string',
};

const EMPTY_FORM: TemplateForm = {
  name: '',
  description: '',
  sections: [{ ...EMPTY_SECTION }],
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export type TemplateEditorMode = 'create' | 'edit' | 'duplicate';

interface TemplateEditorProps {
  open: boolean;
  mode: TemplateEditorMode;
  sourceId?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function TemplateEditor({ open, mode, sourceId, onClose, onSaved }: TemplateEditorProps) {
  const [id, setId] = useState('');
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isIdEditable = mode !== 'edit';

  useEffect(() => {
    if (!open) return;

    setError(null);

    if (mode === 'create') {
      setId('');
      setForm({ ...EMPTY_FORM, sections: [{ ...EMPTY_SECTION }] });
      return;
    }

    if (!sourceId) return;

    setLoading(true);
    invoke<TemplateForm>('api_get_template', { templateId: sourceId })
      .then((template) => {
        setForm(template);
        setId(mode === 'duplicate' ? `${sourceId}_copy` : sourceId);
      })
      .catch((err) => {
        toast.error('No se pudo cargar la plantilla', {
          description: err instanceof Error ? err.message : String(err),
        });
        onClose();
      })
      .finally(() => setLoading(false));
  }, [open, mode, sourceId, onClose]);

  // Auto-suggest an id from the name while creating (user can still edit it).
  useEffect(() => {
    if (mode !== 'create') return;
    setId((prev) => {
      const suggested = slugify(form.name);
      // Only auto-fill if the user hasn't diverged from the auto-suggestion yet.
      if (prev === '' || prev === slugify(prev)) return suggested;
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.name, mode]);

  const updateSection = (index: number, patch: Partial<TemplateSectionForm>) => {
    setForm((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  };

  const addSection = (section: TemplateSectionForm = { ...EMPTY_SECTION }) => {
    setForm((prev) => ({ ...prev, sections: [...prev.sections, { ...section }] }));
  };

  const removeSection = (index: number) => {
    setForm((prev) => ({ ...prev, sections: prev.sections.filter((_, i) => i !== index) }));
  };

  const moveSection = (index: number, direction: -1 | 1) => {
    setForm((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.sections.length) return prev;
      const sections = [...prev.sections];
      [sections[index], sections[target]] = [sections[target], sections[index]];
      return { ...prev, sections };
    });
  };

  const handleSave = async () => {
    setError(null);

    const safeId = slugify(id);
    if (!safeId) {
      setError('Ponle un identificador a la plantilla (solo letras, números y guiones bajos).');
      return;
    }
    if (!form.name.trim()) {
      setError('El nombre no puede estar vacío.');
      return;
    }
    if (!form.description.trim()) {
      setError('La descripción no puede estar vacía.');
      return;
    }
    if (form.sections.length === 0) {
      setError('Agrega al menos una sección.');
      return;
    }
    for (const section of form.sections) {
      if (!section.title.trim() || !section.instruction.trim()) {
        setError('Cada sección necesita un título y una instrucción.');
        return;
      }
    }

    setSaving(true);
    try {
      await invoke('api_validate_template', {
        templateJson: JSON.stringify(form),
      });
      await invoke('api_save_template', { templateId: safeId, template: form });
      toast.success('Plantilla guardada', { description: form.name });
      onSaved();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const titleByMode: Record<TemplateEditorMode, string> = {
    create: 'Nueva plantilla',
    edit: 'Editar plantilla',
    duplicate: 'Duplicar plantilla',
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{titleByMode[mode]}</DialogTitle>
          <DialogDescription>
            Define qué secciones debe incluir el resumen y qué debe escribir la IA en cada una.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-gray-500">Cargando plantilla…</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="template-id">Identificador</Label>
                <Input
                  id="template-id"
                  value={id}
                  disabled={!isIdEditable}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="ej: reunion_ventas"
                />
              </div>
              <div>
                <Label htmlFor="template-name">Nombre</Label>
                <Input
                  id="template-name"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Reunión de ventas"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="template-description">Descripción</Label>
              <Input
                id="template-description"
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Resumen breve del propósito de esta plantilla"
              />
            </div>

            <div className="flex items-center justify-between">
              <Label>Secciones</Label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => addSection(DATE_SECTION)}>
                  <CalendarDays className="w-4 h-4 mr-1" /> Agregar sección de fecha
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => addSection()}>
                  <Plus className="w-4 h-4 mr-1" /> Agregar sección
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {form.sections.map((section, index) => (
                <div key={index} className="border rounded-lg p-3 space-y-2 bg-gray-50">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <Input
                        value={section.title}
                        onChange={(e) => updateSection(index, { title: e.target.value })}
                        placeholder="Título de la sección"
                      />
                      <Select
                        value={section.format}
                        onValueChange={(value) =>
                          updateSection(index, { format: value as TemplateSectionFormat })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="paragraph">Párrafo</SelectItem>
                          <SelectItem value="list">Lista</SelectItem>
                          <SelectItem value="string">Texto corto</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => moveSection(index, -1)}
                        disabled={index === 0}
                        className="p-1 rounded hover:bg-gray-200 disabled:opacity-30"
                        aria-label="Mover arriba"
                      >
                        <ChevronUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSection(index, 1)}
                        disabled={index === form.sections.length - 1}
                        className="p-1 rounded hover:bg-gray-200 disabled:opacity-30"
                        aria-label="Mover abajo"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSection(index)}
                      className="p-1.5 rounded hover:bg-red-50 text-red-600 flex-shrink-0"
                      aria-label="Eliminar sección"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <Textarea
                    value={section.instruction}
                    onChange={(e) => updateSection(index, { instruction: e.target.value })}
                    placeholder="Instrucción para la IA sobre qué escribir en esta sección"
                    rows={2}
                  />
                </div>
              ))}
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
