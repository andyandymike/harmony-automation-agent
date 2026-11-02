@Entry
@Component
struct Index {
  @State private inputValue: string = '';
  @State private outputValue: string = 'Waiting';
  @State private counter: number = 0;
  @State private switchOn: boolean = false;
  @State private delayedValue: string = 'Idle';
  @State private selectedRow: string = 'None';
  private delayedTimer: number = -1;

  private resetFixture(): void {
    if (this.delayedTimer !== -1) {
      clearTimeout(this.delayedTimer);
      this.delayedTimer = -1;
    }
    this.inputValue = '';
    this.outputValue = 'Waiting';
    this.counter = 0;
    this.switchOn = false;
    this.delayedValue = 'Idle';
    this.selectedRow = 'None';
  }

  aboutToDisappear(): void {
    if (this.delayedTimer !== -1) {
      clearTimeout(this.delayedTimer);
      this.delayedTimer = -1;
    }
  }

  build() {
    Scroll() {
      Column({ space: 12 }) {
        Text('Harmony Agent Fixture v2')
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .key('fixture.title')
        Text('READY')
          .key('fixture.ready')

        Text('Standard input (system keyboard)')
          .fontSize(12)
          .key('fixture.input.standard.label')
        TextInput({ text: this.inputValue, placeholder: '输入中文 / English / 123' })
          .width('100%')
          .height(48)
          .key('fixture.input')
          .onChange((value: string) => {
            this.inputValue = value;
          })
        Text('Native input (no soft keyboard)')
          .fontSize(12)
          .key('fixture.input.native.label')
        TextInput({ text: this.inputValue, placeholder: 'Native 中文 / English / 123' })
          .width('100%')
          .height(44)
          .enableKeyboardOnFocus(false)
          .key('fixture.input.native')
          .onChange((value: string) => {
            this.inputValue = value;
          })
        Text(this.inputValue.length === 0 ? 'Value: <empty>' : 'Value: ' + this.inputValue)
          .width('100%')
          .key('fixture.input.value')
        Button('Submit')
          .width('100%')
          .key('fixture.submit')
          .onClick(() => {
            this.outputValue = 'Hello, ' + this.inputValue;
          })
        Text(this.outputValue)
          .width('100%')
          .fontSize(20)
          .key('fixture.output')

        Row({ space: 12 }) {
          Button('Increment')
            .key('fixture.increment')
            .onClick(() => {
              this.counter += 1;
            })
          Text('Counter: ' + this.counter.toString())
            .key('fixture.counter')
        }
        .width('100%')

        Row({ space: 12 }) {
          Text('Notifications')
            .key('fixture.switch.label')
          Toggle({ type: ToggleType.Switch, isOn: this.switchOn })
            .key('fixture.switch')
            .onChange((isOn: boolean) => {
              this.switchOn = isOn;
            })
          Text(this.switchOn ? 'On' : 'Off')
            .key('fixture.switch.value')
        }
        .width('100%')

        Row({ space: 12 }) {
          Button('Load delayed')
            .key('fixture.delayed.start')
            .onClick(() => {
              if (this.delayedTimer !== -1) {
                clearTimeout(this.delayedTimer);
              }
              this.delayedValue = 'Loading';
              this.delayedTimer = setTimeout(() => {
                this.delayedValue = 'Ready after delay';
                this.delayedTimer = -1;
              }, 600);
            })
          Text(this.delayedValue)
            .key('fixture.delayed.status')
        }
        .width('100%')

        Button('Reset')
          .width('100%')
          .key('fixture.reset')
          .onClick(() => {
            this.resetFixture();
          })

        Row({ space: 12 }) {
          Text('Order A')
            .key('fixture.row.a.label')
          Button('Choose')
            .key('fixture.row.a.choose')
            .onClick(() => {
              this.selectedRow = 'Order A';
            })
        }
        .width('100%')
        .key('fixture.row.a')
        Row({ space: 12 }) {
          Text('Order B')
            .key('fixture.row.b.label')
          Button('Choose')
            .key('fixture.row.b.choose')
            .onClick(() => {
              this.selectedRow = 'Order B';
            })
        }
        .width('100%')
        .key('fixture.row.b')
        Text('Selected: ' + this.selectedRow)
          .key('fixture.selected')

        ForEach([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], (item: number) => {
          Text('Scroll item ' + item.toString())
            .width('100%')
            .height(60)
            .key('fixture.scroll.item.' + item.toString())
        }, (item: number) => item.toString())
        Text('END OF FIXTURE')
          .key('fixture.scroll.end')
      }
      .width('100%')
      .padding(20)
    }
    .width('100%')
    .height('100%')
    .key('fixture.scroll')
  }
}
