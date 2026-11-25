// Mattermost's message priority as posts carry it: the tag after a sent post's time. The server has it when its
// client config says `PostPriority`, and it travels in the post's `metadata.priority`. A draft started in the web
// app keeps its priority when it's sent from here.
import { svg } from "gpui-kit";
import { h_flex } from "gpui-base";

const INFO = "#5d89ea", DANGER = "#d24b4e";
const icon = (name, size) => svg(`mods/mattermost/icons/compass/${name}.svg`).size(size).flex_none();

const PRIORITIES = [
  { value: "important", label: "Important", icon: "alert-circle-outline", color: INFO },
  { value: "urgent", label: "Urgent", icon: "alert-outline", color: DANGER },
];

export const priorityEnabled = (config) => config?.PostPriority === "true";

export const hasPriority = (p) => Boolean(p?.priority || p?.requested_ack);

// Mattermost's Tag, xs: the label in capitals on the priority's colour.
export function priorityTag(priority) {
  const p = PRIORITIES.find((x) => x.value === priority);
  if (!p) return null;
  return h_flex().h(16).px(4).gap(2).flex_none().items_center().rounded(4).bg(p.color).text_color("#ffffff")
    .text_size(10).line_height("16px").font_semibold().child(icon(p.icon, 12)).child(p.label.toUpperCase());
}
