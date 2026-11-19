import type { App, Plugin } from 'vue'
import {
  Alert, Avatar, Badge, Breadcrumb, Button, Card, Checkbox, Col, Collapse, ConfigProvider, DatePicker, Descriptions, Divider,
  Drawer, Dropdown, Empty, Form, Input, InputNumber, Layout, List, Menu, Modal, Pagination, Popconfirm, Popover, Progress,
  Radio, Result, Row, Segmented, Select, Skeleton, Slider, Space, Spin, Statistic, Steps, Switch, Table, Tabs, Tag, Timeline,
  Tooltip, Typography, Upload,
} from 'ant-design-vue'

/**
 * The Ant Design components the templates use (`<a-*>`), registered globally instead of `app.use(Antd)`, so the
 * unused ones (Cascader, Transfer, Tree, Carousel, QRCode, …) stay out of the bundle. Each component's own install
 * also registers its parts (Form → a-form-item, Input → a-textarea / a-input-search / a-input-password, Menu →
 * a-menu-item / a-sub-menu, …). A template using a new `<a-*>` component needs it added here.
 */
const COMPONENTS: Plugin[] = [
  Alert, Avatar, Badge, Breadcrumb, Button, Card, Checkbox, Col, Collapse, ConfigProvider, DatePicker, Descriptions, Divider,
  Drawer, Dropdown, Empty, Form, Input, InputNumber, Layout, List, Menu, Modal, Pagination, Popconfirm, Popover, Progress,
  Radio, Result, Row, Segmented, Select, Skeleton, Slider, Space, Spin, Statistic, Steps, Switch, Table, Tabs, Tag, Timeline,
  Tooltip, Typography, Upload,
]

export function installAntd(app: App) {
  for (const c of COMPONENTS) app.use(c)
}
