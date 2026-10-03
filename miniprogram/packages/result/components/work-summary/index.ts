Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    thumbnailSrc: { type: String, value: '' },
    title: { type: String, value: '' },
    dimensions: { type: String, value: '' },
    colorCount: { type: Number, value: 0 },
    beadCount: { type: Number, value: 0 },
    createdText: { type: String, value: '' },
    isFavorite: { type: Boolean, value: false },
    favoriteUpdating: { type: Boolean, value: false },
    renamingTitle: { type: Boolean, value: false },
  },

  methods: {
    onEditTitle() {
      this.triggerEvent('edittitle')
    },

    onToggleFavorite() {
      this.triggerEvent('togglefavorite')
    },
  },
})
