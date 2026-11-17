import { defineComponent, type VNode } from 'vue'

/** Renders the given vnodes (e.g. `menuNode` inside an a-select `#dropdownRender`). */
export default defineComponent({ props: { vnodes: { type: Object, required: true } }, render() { return this.vnodes as VNode } })
