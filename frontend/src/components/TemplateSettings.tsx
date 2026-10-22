import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { TemplateEditor, TemplateEditorMode } from '@/components/TemplateEditor';

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  is_custom: boolean;
}

interface EditorState {
  open: boolean;
  mode: TemplateEditorMode;
  sourceId?: string;
}

export function TemplateSettings() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ open: false, mode: 'create' });

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<TemplateInfo[]>('api_list_templates');
      setTemplates(list);
    } catch (error) {
      console.error('Failed to load templates:', error);
      toast.error('No se pudieron cargar las plantillas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleDelete = async (template: TemplateInfo) => {
    if (!window.confirm(`¿Eliminar la plantilla "${template.name}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    setDeletingId(template.id);
    try {
      await invoke('api_delete_template', { templateId: template.id });
      toast.success('Plantilla eliminada', { description: template.name });
      await loadTemplates();
    } catch (error) {
      toast.error('No se pudo eliminar la plantilla', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold mb-1">Plantillas de resumen</h3>
          <p className="text-sm text-gray-600">
            Define qué secciones pide cada resumen de reunión y qué debe escribir la IA en cada una.
          </p>
        </div>
        <Button onClick={() => setEditor({ open: true, mode: 'create' })}>
          <Plus className="w-4 h-4 mr-1" /> Nueva plantilla
        </Button>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-3">
          <div className="h-16 bg-gray-200 rounded-lg" />
          <div className="h-16 bg-gray-200 rounded-lg" />
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between p-4 border rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{template.name}</span>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      template.is_custom
                        ? 'bg-blue-50 text-blue-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {template.is_custom ? 'Personalizada' : 'Predefinida'}
                  </span>
                </div>
                <p className="text-sm text-gray-600 truncate">{template.description}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditor({ open: true, mode: 'duplicate', sourceId: template.id })}
                >
                  <Copy className="w-4 h-4 mr-1" /> Duplicar
                </Button>
                {template.is_custom && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditor({ open: true, mode: 'edit', sourceId: template.id })}
                    >
                      <Pencil className="w-4 h-4 mr-1" /> Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 hover:bg-red-50"
                      disabled={deletingId === template.id}
                      onClick={() => handleDelete(template)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <TemplateEditor
        open={editor.open}
        mode={editor.mode}
        sourceId={editor.sourceId}
        onClose={() => setEditor({ open: false, mode: 'create' })}
        onSaved={loadTemplates}
      />
    </div>
  );
}
