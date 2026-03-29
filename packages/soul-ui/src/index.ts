/**
 * @seosoyoung/soul-ui - Barrel Export
 *
 * soul-dashboard에서 추출한 공유 UI 컴포넌트, 스토어, 유틸리티, 훅, 타입을 제공합니다.
 */

// === Style Constants ===
export { NODE_COLORS } from "./styles/node-colors";

// === Shared Constants ===
export { SYSTEM_FOLDERS, DEFAULT_FOLDER_KEY, SSE_EVENT_TYPES } from "./shared/constants";

// === Shared Types ===
export type {
  SSEEventType,
  ProgressEvent,
  MemoryEvent,
  SessionEvent,
  InterventionSentEvent,
  ContextItem,
  UserMessageEvent,
  DebugEvent,
  CompleteEvent,
  ErrorEvent,
  ContextUsageEvent,
  CompactEvent,
  ThinkingEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolStartEvent,
  ToolResultEvent,
  ResultEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  ReconnectEvent,
  HistorySyncEvent,
  InputRequestQuestion,
  InputRequestEvent,
  InputRequestExpiredEvent,
  InputRequestRespondedEvent,
  AssistantMessageEvent,
  SoulSSEEvent,
  EventRecord,
  SessionStatus,
  LlmUsage,
  SessionSummary,
  SessionDetail,
  EventTreeNodeType,
  SessionNode,
  UserMessageNode,
  InterventionNode,
  ThinkingNode,
  TextNode,
  ToolNode,
  ResultNode,
  CompactNode,
  CompleteNode,
  ErrorNode,
  InputRequestNodeDef,
  AssistantMessageNode,
  EventTreeNode,
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  InterveneResponse,
  SendRespondRequest,
  RespondResponse,
  SessionListResponse,
  ApiError,
  DashboardSSEEvent,
  SessionListStreamEvent,
  SessionCreatedStreamEvent,
  SessionUpdatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionStreamEvent,
  FolderSettings,
  CatalogFolder,
  CatalogAssignment,
  CatalogState,
  CatalogUpdatedStreamEvent,
  MetadataEntry,
  MetadataUpdatedStreamEvent,
  AgentInfo,
  AgentProfile,
} from "./shared/types";

// === Shared Mappers ===
export { toSessionSummary } from "./shared/mappers";

// === SSE Session Provider ===
export { SSESessionProvider, sseSessionProvider } from "./providers/SSESessionProvider";

// === Provider Types ===
export type {
  StorageMode,
  FetchSessionsOptions,
  SessionListResult,
  SessionListProvider,
  SessionDetailProvider,
  SessionStorageProvider,
  SoulBlockType,
  SerendipityBlock,
  PortableTextContent,
  PortableTextBlock,
  PortableTextSpan,
  PortableTextMarkDef,
  SessionKey,
} from "./providers/types";

// === Stores ===
export {
  useDashboardStore,
  isSessionUnread,
  countTreeNodes,
  countStreamingNodes,
  findTreeNode,
} from "./stores/dashboard-store";
export type {
  ProfileConfig,
  DashboardConfig,
  DashboardAgentConfig,
  SelectedEventNodeData,
  DashboardState,
  DashboardActions,
} from "./stores/dashboard-store";

export type { ProcessingContext, TextTargetNode } from "./stores/processing-context";
export { createProcessingContext, makeNode, registerNode, ensureRoot } from "./stores/processing-context";
export { createNodeFromEvent, applyUpdate } from "./stores/node-factory";
export { resolveParent, placeInTree, handleTextStart } from "./stores/tree-placer";
export { shouldNotify, deriveSessionStatus } from "./stores/session-updater";

// === Lib ===
export { cn } from "./lib/cn";
export { BATCH_SIZE, BATCH_FLUSH_MS } from "./lib/event-batch";
export { flattenTree } from "./lib/flatten-tree";
export type { ChatMessage } from "./lib/flatten-tree";
export { submitInputResponse } from "./lib/input-request-actions";
export { formatTime } from "./lib/input-request-utils";

// === Layout Components ===
export { DashboardShell } from "./components/DashboardShell";
export type { DashboardShellProps } from "./components/DashboardShell";
export { DragHandle } from "./components/DragHandle";
export type { DragHandleProps } from "./components/DragHandle";
export { ConnectionBadge } from "./components/ConnectionBadge";
export type { ConnectionBadgeProps, ConnectionStatus } from "./components/ConnectionBadge";

// === Folder / Session Operations ===
export { createFolderOperations } from "./lib/folder-operations";
export type { FolderApiConfig, FolderOperations } from "./lib/folder-operations";
export { createMoveSessionsOperations } from "./lib/move-sessions";
export type { MoveSessionsApiConfig, MoveSessionsOperations } from "./lib/move-sessions";

// === Hooks ===
export { useTheme, initTheme, setTheme } from "./hooks/useTheme";
export type { Theme } from "./hooks/useTheme";
export { useInputRequestTimer } from "./hooks/useInputRequestTimer";
export { useIsMobile } from "./hooks/use-mobile";

// === Components ===
export { FolderTree } from "./components/FolderTree";
export type { FolderTreeProps } from "./components/FolderTree";
export { FolderContents, nodeIdToHue, STATUS_CONFIG } from "./components/FolderContents";
export type { FolderContentsProps, StatusConfig } from "./components/FolderContents";
export { FeedCard } from "./components/FeedCard";
export type { FeedCardProps } from "./components/FeedCard";
export { FeedView } from "./components/FeedView";
export { FeedTopBar } from "./components/FeedTopBar";
export type { FeedTopBarProps } from "./components/FeedTopBar";
export { FolderDialog } from "./components/FolderDialog";
export { FolderSettingsDialog } from "./components/FolderSettingsDialog";
export type { FolderSettingsDialogProps } from "./components/FolderSettingsDialog";
export { ChatView } from "./components/ChatView";
export { ChatInput } from "./components/ChatInput";
export { RightPanel } from "./components/RightPanel";
export { DetailView } from "./components/DetailView";
export { SessionInfoView } from "./components/SessionInfoView";
export { AskQuestionBanner } from "./components/AskQuestionBanner";
export { ProfileAvatar } from "./components/ProfileAvatar";
export { ContextContentRenderer } from "./components/ContextContentRenderer";

// === NodeGraph (Execution Flow) ===
export { NodeGraph } from "./components/NodeGraph";
export {
  buildGraph,
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
} from "./lib/layout-engine";
export type { GraphNode, GraphEdge, GraphNodeData } from "./lib/layout-engine";

// === Dashboard Components (extracted from soul-dashboard) ===
export { SessionsTopBar } from "./components/SessionsTopBar";
export { VerticalSplitPane } from "./components/VerticalSplitPane";
export { MobileChatHeader } from "./components/MobileChatHeader";
export { ThemeToggle } from "./components/ThemeToggle";
export { StorageModeToggle, StorageModeToggleCompact } from "./components/StorageModeToggle";
export { ConfigButton } from "./components/ConfigButton";
export { NewSessionDialog } from "./components/NewSessionDialog";
export type { NewSessionDialogProps } from "./components/NewSessionDialog";

// === Dashboard Hooks (extracted from soul-dashboard) ===
export { useSessionListProvider } from "./hooks/useSessionListProvider";
export type { UseSessionListProviderOptions } from "./hooks/useSessionListProvider";
export { useSessionProvider } from "./hooks/useSessionProvider";
export type { UseSessionProviderOptions } from "./hooks/useSessionProvider";
export { useReadPositionSync } from "./hooks/useReadPositionSync";
export { useNotification } from "./hooks/useNotification";
export { useUrlSync } from "./hooks/useUrlSync";
export { useDashboardConfig } from "./hooks/useDashboardConfig";
export { useServerStatus } from "./hooks/useServerStatus";

// === Dashboard Lib (extracted from soul-dashboard) ===
export { renameSessionOptimistic } from "./lib/rename-session";

// === Detail Components ===
export { ErrorDetail } from "./components/detail/ErrorDetail";
export { SubAgentDetail } from "./components/detail/SubAgentDetail";
export { ThinkingDetail } from "./components/detail/ThinkingDetail";
export { ToolDetail } from "./components/detail/ToolDetail";
export { SessionMetadata } from "./components/detail/SessionMetadata";
export { SectionLabel, CodeBlock, safeStringify } from "./components/detail/shared";

// === UI Components ===
export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
  AccordionPanel as AccordionContent,
} from "./components/ui/accordion";

export {
  AlertDialogCreateHandle,
  AlertDialog,
  AlertDialogPortal,
  AlertDialogBackdrop,
  AlertDialogBackdrop as AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogPopup,
  AlertDialogPopup as AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogClose,
  AlertDialogViewport,
} from "./components/ui/alert-dialog";

export { Alert, AlertTitle, AlertDescription, AlertAction } from "./components/ui/alert";

export {
  Autocomplete,
  AutocompleteInput,
  AutocompleteTrigger,
  AutocompletePopup,
  AutocompleteItem,
  AutocompleteSeparator,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteEmpty,
  AutocompleteValue,
  AutocompleteList,
  AutocompleteClear,
  AutocompleteStatus,
  AutocompleteRow,
  AutocompleteCollection,
  useAutocompleteFilter,
} from "./components/ui/autocomplete";

export { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar";
export { Badge, badgeVariants } from "./components/ui/badge";

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from "./components/ui/breadcrumb";

export { Button, buttonVariants } from "./components/ui/button";
export { Calendar } from "./components/ui/calendar";

export {
  Card,
  CardFrame,
  CardFrameHeader,
  CardFrameTitle,
  CardFrameDescription,
  CardFrameFooter,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardPanel as CardContent,
  CardTitle,
} from "./components/ui/card";

export { CheckboxGroup } from "./components/ui/checkbox-group";
export { Checkbox } from "./components/ui/checkbox";

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
} from "./components/ui/collapsible";

export {
  Combobox,
  ComboboxChipsInput,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxSeparator,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxEmpty,
  ComboboxValue,
  ComboboxList,
  ComboboxClear,
  ComboboxStatus,
  ComboboxRow,
  ComboboxCollection,
  ComboboxChips,
  ComboboxChip,
  useComboboxFilter,
} from "./components/ui/combobox";

export {
  CommandCreateHandle,
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "./components/ui/command";

export {
  DialogCreateHandle,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
} from "./components/ui/dialog";

export {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "./components/ui/empty";

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldControl,
  FieldItem,
  FieldValidity,
} from "./components/ui/field";

export { Fieldset, FieldsetLegend } from "./components/ui/fieldset";
export { Form } from "./components/ui/form";

export {
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
  FrameFooter,
} from "./components/ui/frame";

export {
  Group,
  Group as ButtonGroup,
  GroupText,
  GroupText as ButtonGroupText,
  GroupSeparator,
  GroupSeparator as ButtonGroupSeparator,
  groupVariants,
} from "./components/ui/group";

export {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
} from "./components/ui/input-group";

export { Input } from "./components/ui/input";
export type { InputProps } from "./components/ui/input";
export { Kbd, KbdGroup } from "./components/ui/kbd";
export { Label } from "./components/ui/label";

export {
  MenuCreateHandle,
  MenuCreateHandle as DropdownMenuCreateHandle,
  Menu,
  Menu as DropdownMenu,
  MenuPortal,
  MenuPortal as DropdownMenuPortal,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
} from "./components/ui/menu";

export { Meter, MeterLabel, MeterTrack, MeterIndicator, MeterValue } from "./components/ui/meter";

export {
  NumberField,
  NumberFieldScrubArea,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldGroup,
  NumberFieldInput,
} from "./components/ui/number-field";

export {
  Pagination,
  PaginationContent,
  PaginationLink,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "./components/ui/pagination";

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
} from "./components/ui/popover";

export {
  PreviewCard,
  PreviewCard as HoverCard,
  PreviewCardTrigger,
  PreviewCardTrigger as HoverCardTrigger,
  PreviewCardPopup,
  PreviewCardPopup as HoverCardContent,
} from "./components/ui/preview-card";

export {
  Progress,
  ProgressLabel,
  ProgressTrack,
  ProgressIndicator,
  ProgressValue,
} from "./components/ui/progress";

export { RadioGroup, Radio, Radio as RadioGroupItem } from "./components/ui/radio-group";
export { ScrollArea, ScrollBar } from "./components/ui/scroll-area";

export {
  Select,
  SelectTrigger,
  SelectButton,
  selectTriggerVariants,
  SelectValue,
  SelectPopup,
  SelectPopup as SelectContent,
  SelectItem,
  SelectSeparator,
  SelectGroup,
  SelectGroupLabel,
} from "./components/ui/select";

export { Separator } from "./components/ui/separator";

export {
  Sheet,
  SheetTrigger,
  SheetPortal,
  SheetClose,
  SheetBackdrop,
  SheetBackdrop as SheetOverlay,
  SheetPopup,
  SheetPopup as SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetPanel,
} from "./components/ui/sheet";

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";

export { Skeleton } from "./components/ui/skeleton";
export { Slider, SliderValue } from "./components/ui/slider";
export { Spinner } from "./components/ui/spinner";
export { Switch } from "./components/ui/switch";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./components/ui/table";

export {
  Tabs,
  TabsList,
  TabsTab,
  TabsTab as TabsTrigger,
  TabsPanel,
  TabsPanel as TabsContent,
} from "./components/ui/tabs";

export { Textarea } from "./components/ui/textarea";
export type { TextareaProps } from "./components/ui/textarea";

export {
  ToastProvider,
  AnchoredToastProvider,
  toastManager,
  anchoredToastManager,
} from "./components/ui/toast";
export type { ToastPosition } from "./components/ui/toast";

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem, ToggleGroupSeparator } from "./components/ui/toggle-group";
export { Toggle as ToggleStandalone, toggleVariants } from "./components/ui/toggle";

export {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarLink,
  ToolbarInput,
} from "./components/ui/toolbar";

export {
  TooltipCreateHandle,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipPopup as TooltipContent,
} from "./components/ui/tooltip";

// === Auth ===
export { AuthProvider, useAuth } from "./providers/AuthProvider";
export type { AuthContextValue, AuthUser } from "./providers/AuthProvider";
export { Login } from "./components/auth/Login";
export { AuthGate } from "./components/auth/AuthGate";
