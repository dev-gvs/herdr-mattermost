// Overlays drawn by other copies of this mod: the dialog for editing a channel's purpose or header (the
// panel picks up the change from the server's channel_updated event), and a user's custom status card.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { FONT, alpha } from "../main.js";

const FIELDS = {
  purpose: { title: "Edit Purpose", hint: (kind) => `This text appears in the "View Info" modal of the ${kind}.` },
  header: { title: "Edit Header", hint: () => "Edit the text appearing next to the channel name in the header." },
};

export class EditDialog {
  constructor(view) {
    this.view = view;
    this.spec = props().edit;
    this.error = null;
    this.saving = false;
    this.text = TextareaState.new({ value: this.spec.value ?? "", rows: 5 });
    this.text.focus();
  }

  close() {
    closeOverlay(props().overlay);
  }

  save(cx) {
    if (this.saving) return;
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        await this.view.api(cx, `/channels/${this.spec.channel.id}/patch`, { method: "PUT", body: { [this.spec.field]: this.text.value().trim() } });
        this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const { field, channel } = this.spec;
    const kind = channel.type === "P" ? "private channel" : channel.type === "O" ? "public channel" : "conversation";
    const button = (id, label, primary, onClick) => div().id(id).h(40).px(16).flex().items_center().rounded(4).cursor_pointer().text_size(14).font_semibold()
      .bg(primary ? t.accent : alpha(t.accent, 0.08)).text_color(primary ? t.accent_foreground : t.accent)
      .hover((s) => s.bg(primary ? t.accent : alpha(t.accent, 0.16)))
      .on_click(onClick).child(label);
    return v_flex().id("mm-edit").size_full().p(32).gap(16).bg(t.popover).font_family(FONT).text_color(t.foreground)
      .child(h_flex().items_center().gap(12)
        .child(div().flex_1().min_w(0).truncate().text_size(22).font_semibold().child(`${FIELDS[field].title} for ${channel.display}`))
        .child(div().id("edit-close").size(32).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.close()).child(svg("mods/mattermost/icons/x.svg").size(18))))
      .child(div().text_size(14).child(FIELDS[field].hint(kind)))
      .child(div().h(130).p(12).rounded(4).border_1().border_color(t.accent).bg(t.background)
        .child(Textarea.new(this.text).size_full().text_size(14)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().gap(8)
        .child(button("edit-cancel", "Cancel", false, () => this.close()))
        .child(button("edit-save", this.saving ? "Saving…" : "Save", true, (_e, cx) => this.save(cx))));
  }
}

// Mattermost's custom status tooltip: a small black card, the emoji large above the text and its expiry.
// The popup is larger than the card, so the card hugs the edge nearest the emoji and the rest stays clear.
export class StatusCard {
  render() {
    const { image: path, char, text, until, above } = props().statusCard;
    return v_flex().id("mm-status").size_full().items_center().when(above, (el) => el.justify_end())
      .child(v_flex().max_w_full().px(10).py(8).gap(2).items_center().rounded(4).bg("#000000")
        .font_family(FONT).text_color("#ffffff").text_size(12).line_height("18px")
        .child(path ? image(path).size(40).flex_none().mb(2) : div().text_size(32).child(char))
        .when(Boolean(text), (el) => el.child(div().font_semibold().text_center().child(text)))
        .when(Boolean(until), (el) => el.child(div().font_semibold().text_center().child(until))));
  }
}
